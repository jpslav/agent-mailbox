// The receiving side of a session, shared by `mbox watch` (a stream of blocks on stdout),
// `mbox wait` (one batch, then exit) and `mbox deliverd` (one receiver per registered session): the saved cursor and the ring of recently delivered ids,
// presence (announce, heartbeat, depart), alias changes, the orphan guard, and the connection loop
// with reconnect/backoff. What happens to each message is up to the caller (onMessage).
import fs from 'node:fs';
import { BROADCAST } from './addr.js';
import { parseDelivery } from './envelope.js';
import { HEARTBEAT_MS, presenceRecord } from './registry.js';
import { pidAlive, readCursor, readState, statePath, writeCursor } from './state.js';
import type {
  Config,
  Delivery,
  DeliveryResult,
  Env,
  Message,
  SessionState,
  Transport,
} from './types.js';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const jitter = (ms: number): number => Math.round(ms * (0.75 + Math.random() * 0.5));
const MAX_SEEN = 500;

export interface ReceiverOptions {
  pollMs: number;
  heartbeatMs: number;
  pidCheckMs: number;
  restoredAfterMs: number;
  stableAfterMs: number;
  maxBackoffMs: number;
  redeliverAfterMs: number;
  /** How long stopping waits for deliveries already handed out (see SubscribeOptions.settleMs). */
  settleMs: number;
}

export function receiverOptions(env: Env = process.env): ReceiverOptions {
  return {
    pollMs: Number(env.AGENT_MAILBOX_POLL_MS) || 5000,
    heartbeatMs: Number(env.AGENT_MAILBOX_HEARTBEAT_MS) || HEARTBEAT_MS,
    pidCheckMs: Number(env.AGENT_MAILBOX_PID_CHECK_MS) || 30000,
    restoredAfterMs: Number(env.AGENT_MAILBOX_RESTORED_AFTER_MS) || 3000,
    stableAfterMs: Number(env.AGENT_MAILBOX_STABLE_AFTER_MS) || 60000,
    maxBackoffMs: Number(env.AGENT_MAILBOX_MAX_BACKOFF_MS) || 60000,
    redeliverAfterMs: Number(env.AGENT_MAILBOX_REDELIVER_MS) || 60000,
    // Long enough for a delivery in flight to finish (an inbox post gives up after 10 s) and be
    // acknowledged, so stopping (a daemon handing over) neither drops nor repeats it.
    settleMs: 12000,
  };
}

export interface OpenReceiverInput {
  cfg: Pick<Config, 'user'>;
  transport: Transport;
  sid: string;
  /** The session's state, as ensureSession left it. */
  st: SessionState;
  agent?: string;
  hostPid?: number | null;
  env?: Env;
  /** stop() leaves the transport open (a process that serves several sessions on one). */
  keepTransport?: boolean;
  /**
   * Abandon the start: when it aborts while the receiver is still opening (the cursor lookup and
   * the presence announcement), no subscription is ever made and the returned receiver is already
   * stopped. A caller that must be able to leave at any moment (`mbox wait` yielding to a newer
   * waiter or a watcher) uses it so a slow broker cannot hold it up.
   */
  signal?: AbortSignal;
  onMessage: (
    delivery: Delivery,
    message: Message,
    fresh: boolean,
  ) => DeliveryResult | Promise<DeliveryResult>;
  onStatus?: (kind: 'lost' | 'restored', hint?: string) => void;
  onTick?: () => void;
  onHostGone?: () => void;
}

/** Messages to record as delivered. */
export interface CommitItem {
  delivery: Delivery;
  message: Message;
}

export interface Receiver {
  /** The session's current state (aliases can change while it runs). */
  state(): SessionState;
  commit(items: CommitItem[]): void;
  stop(opts?: { depart?: boolean }): Promise<void>;
}

/**
 * Start receiving for session `sid` (whose state `st` exists, see ensureSession).
 *
 *   onMessage(delivery, message, fresh) -> what the transport's onMessage returns (its resolution,
 *       or {ackAfter}, acknowledges). `fresh` is false for an id delivered before (redelivery) and
 *       for the session's own broadcasts; the caller still commits those. Calls never overlap.
 *   onStatus('lost', hint) | onStatus('restored')    connection state changes (once each)
 *   onTick()                                          every pollMs (lock upkeep)
 *   onHostGone()                                      the agent process named by hostPid exited
 *
 * Returns {state(), commit(items), stop({depart})}. commit([{delivery, message}]) records them as
 * delivered (cursor + recently delivered ids) on disk; call it before acknowledging.
 * keepTransport: stop() leaves the transport open (a process that serves several sessions on one).
 */
export async function openReceiver({
  cfg,
  transport,
  sid,
  st: initial,
  agent = 'unknown',
  hostPid = null,
  env = process.env,
  keepTransport = false,
  signal,
  onMessage,
  onStatus = () => {},
  onTick = () => {},
  onHostGone = () => {},
}: OpenReceiverInput): Promise<Receiver> {
  const opt = receiverOptions(env);
  let st = initial;
  const stop = new AbortController();
  let stopping: Promise<void> | null = null;
  let streamAc: AbortController | null = null;
  let reconnectRequested = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Resolves with `undefined` as soon as the start is abandoned, whatever `p` is still doing.
  const abandoned = new Promise<undefined>((resolve) => {
    if (signal?.aborted) resolve(undefined);
    else signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const unlessAbandoned = <T>(p: Promise<T>): Promise<T | undefined> =>
    signal ? Promise.race([p, abandoned]) : p;

  const saved = readCursor(sid, env);
  const cur = saved || { cursor: await unlessAbandoned(transport.now()), seen: {} };
  const seen = new Map<string, number>(Object.entries(cur.seen || {}));
  let cursor = cur.cursor;

  const persist = () => {
    // A small ring: keep the newest ids only (Map keeps insertion order).
    while (seen.size > MAX_SEEN) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    try {
      writeCursor(sid, { cursor, seen: Object.fromEntries(seen) }, env);
    } catch {
      /* disk issue: dedupe still in memory */
    }
  };
  function commit(items: CommitItem[]): void {
    for (const { delivery: d, message: m } of items) {
      if (!seen.has(m.id)) seen.set(m.id, d.time || 0);
      cursor = d.cursor ?? cursor;
    }
    persist();
  }

  const addresses = () => [...new Set([st.address, ...st.aliases, BROADCAST])];
  const isSelf = (from: string): boolean => st.address === from || st.aliases.includes(from);

  const post = (kind: 'announce' | 'heartbeat' | 'depart', timeoutMs: number): Promise<void> =>
    transport.presence[kind](presenceRecord(st, { sid, cfg, agent }), { timeoutMs }).catch(
      () => {},
    );

  // ---- announce ----
  await unlessAbandoned(post('announce', 5000));
  if (signal?.aborted) {
    // Abandoned while opening: nothing was subscribed and no timer started; stop() only lets go.
    return {
      state: () => st,
      commit,
      stop: async ({ depart = false }: { depart?: boolean } = {}) => {
        if (depart) await post('depart', 2000);
        if (!keepTransport) await transport.close?.().catch(() => {});
      },
    };
  }

  // ---- housekeeping timers ----
  timers.push(setInterval(() => void post('heartbeat', 5000), opt.heartbeatMs));
  let lastMtime = 0;
  try {
    lastMtime = fs.statSync(statePath(sid, env)).mtimeMs;
  } catch {
    /* */
  }
  timers.push(
    setInterval(() => {
      onTick();
      try {
        const m = fs.statSync(statePath(sid, env)).mtimeMs;
        if (m !== lastMtime) {
          lastMtime = m;
          const next = readState(sid, env);
          if (next && JSON.stringify(next.aliases) !== JSON.stringify(st.aliases)) {
            st = next;
            reconnectRequested = true;
            streamAc?.abort();
            void post('heartbeat', 5000);
          }
        }
      } catch {
        /* state file briefly missing */
      }
    }, opt.pollMs),
  );
  // Orphan guard: when the agent adapter can name the host (agent) process, stop once it is gone.
  if (hostPid) {
    timers.push(
      setInterval(() => {
        if (!stopping && !pidAlive(hostPid)) onHostGone();
      }, opt.pidCheckMs),
    );
  }
  timers.forEach((t) => t.unref?.());

  // ---- message handling ----
  function handle(d: Delivery): DeliveryResult | Promise<DeliveryResult> {
    const m = parseDelivery(d);
    const own = d.to === BROADCAST && m.sender === cfg.user && isSelf(m.from);
    return onMessage(d, m, !seen.has(m.id) && !own);
  }

  // ---- connection loop ----
  let lost = false;
  let backoff = 1000;
  const loop = (async () => {
    while (!stopping) {
      const ac = new AbortController();
      streamAc = ac;
      const link = (): void => ac.abort();
      stop.signal.addEventListener('abort', link, { once: true });
      let restoredTimer: ReturnType<typeof setTimeout> | undefined;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await transport.subscribe({
          session: sid,
          addresses: addresses(),
          cursor,
          signal: ac.signal,
          redeliverAfterMs: opt.redeliverAfterMs,
          settleMs: opt.settleMs,
          onOpen() {
            clearTimeout(restoredTimer);
            clearTimeout(stableTimer);
            restoredTimer = setTimeout(() => {
              if (lost) {
                lost = false;
                onStatus('restored');
              }
            }, opt.restoredAfterMs);
            stableTimer = setTimeout(() => {
              backoff = 1000;
            }, opt.stableAfterMs);
          },
          onMessage: handle,
        });
      } catch (e) {
        if (stopping) break;
        if (reconnectRequested) {
          reconnectRequested = false;
          continue;
        }
        if (!lost) {
          lost = true;
          onStatus(
            'lost',
            (e as { authProblem?: unknown } | null | undefined)?.authProblem
              ? (transport.explainError(e).split(':')[0] ?? '')
              : '',
          );
        }
      } finally {
        clearTimeout(restoredTimer);
        clearTimeout(stableTimer);
        stop.signal.removeEventListener('abort', link);
      }
      if (stopping) break;
      if (reconnectRequested) {
        reconnectRequested = false;
        continue;
      }
      await sleep(jitter(backoff), stop.signal);
      backoff = Math.min(backoff * 2, opt.maxBackoffMs);
    }
  })();

  /**
   * Stop receiving; `depart` also removes the presence entry. Stops taking messages at once (the
   * abort is synchronous), then waits for the ones handed out to be acknowledged or handed back.
   */
  function stopReceiver({ depart = false }: { depart?: boolean } = {}): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      stop.abort();
      streamAc?.abort();
      timers.forEach((t) => clearInterval(t));
      await Promise.race([loop, sleep(opt.settleMs + 3000)]);
      if (depart) await post('depart', 2000);
      if (!keepTransport) await transport.close?.().catch(() => {});
    })();
    return stopping;
  }

  return { state: () => st, commit, stop: stopReceiver };
}
