import { formatBlock } from './envelope.js';
import { openReceiver } from './receiver.js';
import { acquireLock, awaitExit, ensureSession, waiterPid } from './state.js';

/**
 * The push stream: one block per message on stdout, for an agent feature that turns a background
 * process's stdout into notifications (a monitor). We print very little, and each message in a
 * single write(). Returns the process exit code.
 */
export async function runWatch({ cfg, transport, sid, agent = 'unknown', hostPid = null, env = process.env, out = process.stdout, cwd = process.cwd() }) {
  const write = (s) => {
    try { out.write(s); } catch { /* monitor gone */ }
  };
  // Resolves once the bytes are handed to the OS (pipes are asynchronous on some platforms).
  const writeFlushed = (s) =>
    new Promise((resolve) => {
      try {
        out.write(s, () => resolve());
      } catch {
        resolve();
      }
    });
  const fault = env.AGENT_MAILBOX_FAULT || ''; // test-only fault injection: "crash-after-print"

  const st = await ensureSession({ sid, cfg, transport, cwd, hostPid, env });
  const lock = acquireLock(sid, env);
  if (!lock.ok) {
    write(`[mailbox] already being watched (pid ${lock.pid})\n`);
    await transport.close?.();
    return 0;
  }
  // A hook waiter (`mbox wait`) for this session sees our lock and steps aside; let it finish
  // first, so it cannot deliver anything we deliver too.
  const waiter = waiterPid(sid, env);
  if (waiter) await awaitExit(waiter, 10000);

  let rx = null;
  let stopping = false;
  let doneResolve;
  const done = new Promise((r) => (doneResolve = r));
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await rx?.stop({ depart: true });
    lock.release();
    doneResolve();
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void shutdown());
  process.on('exit', () => lock.release());
  out.on?.('error', () => void shutdown());

  // The transport awaits onMessage before acknowledging: print, flush, persist, THEN ack
  // (at-least-once). A redelivery after a crash between print and ack is not fresh (seen ring).
  rx = await openReceiver({
    cfg, transport, sid, st, agent, hostPid, env,
    async onMessage(d, m, fresh) {
      if (fresh) await writeFlushed(formatBlock(m));
      rx.commit([{ delivery: d, message: m }]);
      if (fault === 'crash-after-print') process.kill(process.pid, 'SIGKILL');
    },
    onStatus(kind, hint) {
      if (kind === 'lost') write(`[mailbox] connection lost${hint ? ` (${hint})` : ''}; retrying\n`);
      else write('[mailbox] connection restored\n');
    },
    onTick: () => lock.touch(),
    onHostGone: () => void shutdown(),
  });
  if (stopping) await rx.stop({ depart: true }); // a signal arrived while starting up
  else write(`[mailbox] online as ${st.address}. Send with: mbox send <to> "<text>"\n`);

  await done;
  return 0;
}
