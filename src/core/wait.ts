// `mbox wait`: block until this session has mail, hand it over in ONE write, and exit. Made for
// agents that can run a command in the background and wake the model when it exits with a given
// status (Claude Code: an asyncRewake hook, see src/agents/claude-code.ts). Every time the agent
// finishes a turn it starts a new waiter; the newest one wins.
//
// Single waiter per session: <sid>.wait.lock names the current one. A newer waiter rewrites it;
// the older one notices within AGENT_MAILBOX_WAIT_POLL_MS and exits quietly, and the newer one
// waits for that exit before it subscribes (so the two never deliver the same message). A live
// `mbox watch` for the session (a monitor) takes precedence in both directions.
//
// Delivery is at-least-once, as in watch: messages are written, then recorded in the session's
// cursor file, then acknowledged. A waiter killed after writing but before acknowledging leaves
// them to be delivered again by the next waiter.
import { formatBatch } from './envelope.js';
import { presenceRecord } from './registry.js';
import { openReceiver } from './receiver.js';
import type { Receiver } from './receiver.js';
import { awaitExit, claimWaitLock, ensureSession, pidAlive, readState, stopWaiter, validateSessionId, waiterPid, watcherPid } from './state.js';
import type { Config, Delivery, DeliveryResult, Env, Message, Transport } from './types.js';

/** Longest a timer can wait (setTimeout's limit). */
export const MAX_WAIT_MS = 2 ** 31 - 1;

const handled = (e: Error): Promise<never> => {
  const p = Promise.reject(e);
  p.catch(() => {});
  return p;
};

export interface RunWaitInput {
  cfg: Config;
  transport: Transport;
  sid: string;
  agent?: string;
  hostPid?: number | null;
  env?: Env;
  cwd?: string;
  /** Give up (exit 'idle') after this long without mail. */
  maxWaitMs: number;
  /** Resolves once the text is handed to the OS (the agent reads it). */
  write: (text: string) => Promise<void>;
}

/** 'mail': text written and acknowledged. 'idle': nothing to show (see runWait). */
export type WaitResult = 'mail' | 'idle';

/** A delivery waiting in the batch, with the settle functions of its deferred acknowledgement. */
interface BatchEntry {
  delivery: Delivery;
  message: Message;
  fresh: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * @param write  async (text) -> resolves once the text is handed to the OS (the agent reads it)
 * @returns 'mail' (text written and acknowledged) or 'idle' (superseded, a watcher took over,
 *          maxWaitMs passed, the host process exited, or a signal)
 */
export async function runWait({ cfg, transport, sid, agent = 'unknown', hostPid = null, env = process.env, cwd = process.cwd(), maxWaitMs, write }: RunWaitInput): Promise<WaitResult> {
  const opt = {
    lockPollMs: Number(env.AGENT_MAILBOX_WAIT_POLL_MS) || 250,
    drainMs: Number(env.AGENT_MAILBOX_DRAIN_MS) || 300,
    maxChars: Number(env.AGENT_MAILBOX_WAIT_MAX_CHARS) || 8000,
    fault: env.AGENT_MAILBOX_FAULT || '', // test-only: "crash-after-write"
  };
  const st = await ensureSession({ sid, cfg, transport, cwd, hostPid, env });
  // Claim first, then look for a watcher (watch does the reverse), so one of us always sees the other.
  const lock = claimWaitLock(sid, env);
  const yielded = async (): Promise<'idle'> => {
    lock.release();
    await transport.close?.().catch(() => {});
    return 'idle';
  };
  if (watcherPid(sid, env)) return yielded();
  if (lock.prevPid) await awaitExit(lock.prevPid, 10000);
  if (!lock.mine() || watcherPid(sid, env)) return yielded();

  const batch: BatchEntry[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let finishing: Promise<void> | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let doneResolve!: (result: WaitResult) => void;
  const done = new Promise<WaitResult>((r) => (doneResolve = r));
  let rx: Receiver | null = null; // set before any delivery can arrive; callbacks below rely on it

  function finish(result: WaitResult, { depart = false }: { depart?: boolean } = {}): Promise<void> {
    if (finishing) return finishing;
    finishing = (async () => {
      clearTimeout(drainTimer);
      timers.forEach((t) => clearTimeout(t));
      for (const b of batch.splice(0)) b.reject(new Error('not delivered')); // to the next waiter
      await rx?.stop({ depart });
      lock.release();
      doneResolve(result);
    })();
    return finishing;
  }
  /** Leave quietly unless a batch is already being written (then that write completes). */
  const yieldNow = (opts?: { depart?: boolean }): void => { if (!flushing) void finish('idle', opts); };
  const hostGone = (): boolean => (hostPid ? !pidAlive(hostPid) : false);

  async function flush(): Promise<void> {
    if (flushing || finishing) return;
    flushing = true;
    clearTimeout(drainTimer);
    const items = batch.splice(0);
    const { text, count } = formatBatch(items, { address: rx!.state().address, maxChars: opt.maxChars });
    const delivered = items.slice(0, count);
    const deferred = items.slice(count);
    deferred.forEach((b) => b.reject(new Error('deferred')));
    try {
      await write(text);
    } catch {
      delivered.forEach((b) => b.reject(new Error('write failed')));
      return finish('idle');
    }
    if (opt.fault === 'crash-after-write') process.kill(process.pid, 'SIGKILL');
    rx!.commit(delivered);
    delivered.forEach((b) => b.resolve());
    return finish('mail');
  }

  function onMessage(d: Delivery, m: Message, fresh: boolean): DeliveryResult {
    if (flushing || finishing) return { ackAfter: handled(new Error('not delivered')) };
    // Nothing pending and nothing to show (a redelivery, or our own broadcast): record and ack now.
    if (!fresh && !batch.length) {
      rx!.commit([{ delivery: d, message: m }]);
      return undefined;
    }
    if (fresh && batch.some((b) => b.fresh && b.message.id === m.id)) fresh = false; // same id twice in one batch
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const ackAfter = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    ackAfter.catch(() => {});
    batch.push({ delivery: d, message: m, fresh, resolve, reject });
    if (fresh && !drainTimer) drainTimer = setTimeout(() => void flush(), opt.drainMs);
    if (batch.length >= 500) void flush();
    return { ackAfter };
  }

  const onSignal = () => yieldNow({ depart: hostGone() });
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const sig of signals) process.on(sig, onSignal);

  rx = await openReceiver({
    cfg, transport, sid, st, agent, hostPid, env,
    onMessage,
    onHostGone: () => yieldNow({ depart: true }),
  });
  // Superseded, or a watcher started: step aside. Also keeps our lock fresh.
  const poll = setInterval(() => {
    if (!lock.mine() || watcherPid(sid, env)) yieldNow();
    else lock.touch();
  }, opt.lockPollMs);
  poll.unref?.();
  timers.push(setTimeout(() => yieldNow(), Math.min(Math.max(1, maxWaitMs), MAX_WAIT_MS)));

  const result = await done;
  clearInterval(poll);
  for (const sig of signals) process.off(sig, onSignal);
  return result;
}

/**
 * The agent session ended: stop its waiter and remove its presence entry (unless a `watch`
 * owns the session, which departs by itself). Quick: an agent may give this well under 2 s.
 */
export async function endSession({
  cfg,
  transport,
  sid,
  agent = 'unknown',
  env = process.env,
}: {
  cfg: Pick<Config, 'user'>;
  transport: Pick<Transport, 'presence'>;
  sid: string;
  agent?: string;
  env?: Env;
}): Promise<void> {
  validateSessionId(sid);
  const pid = stopWaiter(sid, env); // it steps aside within its lock poll, without departing
  if (pid) await awaitExit(pid, 300);
  if (watcherPid(sid, env) || waiterPid(sid, env)) return;
  const st = readState(sid, env);
  if (!st) return;
  await transport.presence.depart(presenceRecord(st, { sid, cfg, agent }), { timeoutMs: 1000 }).catch(() => {});
}
