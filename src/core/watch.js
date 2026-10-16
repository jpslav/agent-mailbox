import fs from 'node:fs';
import { BROADCAST } from './addr.js';
import { formatBlock, parseDelivery } from './envelope.js';
import { HEARTBEAT_MS, presenceRecord } from './registry.js';
import { acquireLock, ensureSession, pidAlive, readCursor, readState, statePath, writeCursor } from './state.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
const MAX_SEEN = 500;

/**
 * The push stream. Designed to run as a Claude Code monitor: every stdout line is a
 * notification, so we print very little and each message in a single write().
 * Returns the process exit code.
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
  const opt = {
    pollMs: Number(env.AGENT_MAILBOX_POLL_MS) || 5000,
    heartbeatMs: Number(env.AGENT_MAILBOX_HEARTBEAT_MS) || HEARTBEAT_MS,
    pidCheckMs: Number(env.AGENT_MAILBOX_PID_CHECK_MS) || 30000,
    restoredAfterMs: Number(env.AGENT_MAILBOX_RESTORED_AFTER_MS) || 3000,
    stableAfterMs: Number(env.AGENT_MAILBOX_STABLE_AFTER_MS) || 60000,
    maxBackoffMs: Number(env.AGENT_MAILBOX_MAX_BACKOFF_MS) || 60000,
    redeliverAfterMs: Number(env.AGENT_MAILBOX_REDELIVER_MS) || 60000,
    fault: env.AGENT_MAILBOX_FAULT || '', // test-only fault injection: "crash-after-print"
  };

  let st = await ensureSession({ sid, cfg, transport, cwd, hostPid, env });
  const lock = acquireLock(sid, env);
  if (!lock.ok) {
    write(`[mailbox] already being watched (pid ${lock.pid})\n`);
    await transport.close?.();
    return 0;
  }

  const stop = new AbortController();
  let stopping = false;
  let streamAc = null;
  let reconnectRequested = false;
  const timers = [];
  let doneResolve;
  const done = new Promise((r) => (doneResolve = r));

  const cur = readCursor(sid, env) || { cursor: await transport.now(), seen: {} };
  const seen = new Map(Object.entries(cur.seen || {}));
  let cursor = cur.cursor;

  const persist = () => {
    // A small ring: keep the newest ids only (Map keeps insertion order).
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    try { writeCursor(sid, { cursor, seen: Object.fromEntries(seen) }, env); } catch { /* disk issue: dedupe still in memory */ }
  };

  const addresses = () => [...new Set([st.address, ...st.aliases, BROADCAST])];
  const isSelf = (from) => st.address === from || st.aliases.includes(from);

  const post = (kind, timeoutMs) =>
    transport.presence[kind](presenceRecord(st, { sid, cfg, agent }), { timeoutMs }).catch(() => {});

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    stop.abort();
    streamAc?.abort();
    timers.forEach((t) => clearInterval(t));
    await post('depart', 2000);
    await transport.close?.().catch(() => {});
    lock.release();
    doneResolve();
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void shutdown());
  process.on('exit', () => lock.release());
  out.on?.('error', () => void shutdown());

  // ---- announce ----
  await post('announce', 5000);
  write(`[mailbox] online as ${st.address}. Send with: mbox send <to> "<text>"\n`);

  // ---- housekeeping timers ----
  timers.push(setInterval(() => void post('heartbeat', 5000), opt.heartbeatMs));
  let lastMtime = 0;
  try { lastMtime = fs.statSync(statePath(sid, env)).mtimeMs; } catch { /* */ }
  timers.push(
    setInterval(() => {
      lock.touch();
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
      } catch { /* state file briefly missing */ }
    }, opt.pollMs),
  );
  // Orphan guard: when the agent adapter can name the host (agent) process, exit once it is gone.
  if (hostPid) {
    timers.push(setInterval(() => { if (!pidAlive(hostPid)) void shutdown(); }, opt.pidCheckMs));
  }
  timers.forEach((t) => t.unref?.());

  // ---- message handling ----
  // The transport awaits this before acknowledging: print, flush, persist, THEN ack
  // (at-least-once). A redelivery after a crash between print and ack is caught by `seen`.
  async function handle(d) {
    const m = parseDelivery(d);
    if (!seen.has(m.id)) {
      seen.set(m.id, d.time || 0);
      const own = d.to === BROADCAST && m.sender === cfg.user && isSelf(m.from);
      if (!own) await writeFlushed(formatBlock(m));
    }
    cursor = d.cursor ?? cursor;
    persist();
    if (opt.fault === 'crash-after-print') process.kill(process.pid, 'SIGKILL');
  }

  // ---- connection loop ----
  let lost = false;
  let backoff = 1000;
  (async () => {
    while (!stopping) {
      streamAc = new AbortController();
      const link = () => streamAc.abort();
      stop.signal.addEventListener('abort', link, { once: true });
      let restoredTimer = null;
      let stableTimer = null;
      try {
        await transport.subscribe({
          session: sid,
          addresses: addresses(),
          cursor,
          signal: streamAc.signal,
          redeliverAfterMs: opt.redeliverAfterMs,
          onOpen() {
            clearTimeout(restoredTimer);
            clearTimeout(stableTimer);
            restoredTimer = setTimeout(() => {
              if (lost) { lost = false; write('[mailbox] connection restored\n'); }
            }, opt.restoredAfterMs);
            stableTimer = setTimeout(() => { backoff = 1000; }, opt.stableAfterMs);
          },
          onMessage: handle,
        });
      } catch (e) {
        if (stopping) break;
        if (reconnectRequested) { reconnectRequested = false; continue; }
        if (!lost) {
          lost = true;
          const hint = e?.authProblem ? ` (${transport.explainError(e).split(':')[0]})` : '';
          write(`[mailbox] connection lost${hint}; retrying\n`);
        }
      } finally {
        clearTimeout(restoredTimer);
        clearTimeout(stableTimer);
        stop.signal.removeEventListener('abort', link);
      }
      if (stopping) break;
      if (reconnectRequested) { reconnectRequested = false; continue; }
      await sleep(jitter(backoff), stop.signal);
      backoff = Math.min(backoff * 2, opt.maxBackoffMs);
    }
  })();

  await done;
  return 0;
}
