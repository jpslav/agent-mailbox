// The receiving side of a session, shared by `mbox watch` (a stream of blocks on stdout) and
// `mbox wait` (one batch, then exit): the saved cursor and the ring of recently delivered ids,
// presence (announce, heartbeat, depart), alias changes, the orphan guard, and the connection loop
// with reconnect/backoff. What happens to each message is up to the caller (onMessage).
import fs from 'node:fs';
import { BROADCAST } from './addr.js';
import { parseDelivery } from './envelope.js';
import { HEARTBEAT_MS, presenceRecord } from './registry.js';
import { pidAlive, readCursor, readState, statePath, writeCursor } from './state.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
const MAX_SEEN = 500;

export function receiverOptions(env = process.env) {
  return {
    pollMs: Number(env.AGENT_MAILBOX_POLL_MS) || 5000,
    heartbeatMs: Number(env.AGENT_MAILBOX_HEARTBEAT_MS) || HEARTBEAT_MS,
    pidCheckMs: Number(env.AGENT_MAILBOX_PID_CHECK_MS) || 30000,
    restoredAfterMs: Number(env.AGENT_MAILBOX_RESTORED_AFTER_MS) || 3000,
    stableAfterMs: Number(env.AGENT_MAILBOX_STABLE_AFTER_MS) || 60000,
    maxBackoffMs: Number(env.AGENT_MAILBOX_MAX_BACKOFF_MS) || 60000,
    redeliverAfterMs: Number(env.AGENT_MAILBOX_REDELIVER_MS) || 60000,
  };
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
 */
export async function openReceiver({ cfg, transport, sid, st: initial, agent = 'unknown', hostPid = null, env = process.env, onMessage, onStatus = () => {}, onTick = () => {}, onHostGone = () => {} }) {
  const opt = receiverOptions(env);
  let st = initial;
  const stop = new AbortController();
  let stopping = null;
  let streamAc = null;
  let reconnectRequested = false;
  const timers = [];

  const cur = readCursor(sid, env) || { cursor: await transport.now(), seen: {} };
  const seen = new Map(Object.entries(cur.seen || {}));
  let cursor = cur.cursor;

  const persist = () => {
    // A small ring: keep the newest ids only (Map keeps insertion order).
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    try { writeCursor(sid, { cursor, seen: Object.fromEntries(seen) }, env); } catch { /* disk issue: dedupe still in memory */ }
  };
  function commit(items) {
    for (const { delivery: d, message: m } of items) {
      if (!seen.has(m.id)) seen.set(m.id, d.time || 0);
      cursor = d.cursor ?? cursor;
    }
    persist();
  }

  const addresses = () => [...new Set([st.address, ...st.aliases, BROADCAST])];
  const isSelf = (from) => st.address === from || st.aliases.includes(from);

  const post = (kind, timeoutMs) =>
    transport.presence[kind](presenceRecord(st, { sid, cfg, agent }), { timeoutMs }).catch(() => {});

  // ---- announce ----
  await post('announce', 5000);

  // ---- housekeeping timers ----
  timers.push(setInterval(() => void post('heartbeat', 5000), opt.heartbeatMs));
  let lastMtime = 0;
  try { lastMtime = fs.statSync(statePath(sid, env)).mtimeMs; } catch { /* */ }
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
      } catch { /* state file briefly missing */ }
    }, opt.pollMs),
  );
  // Orphan guard: when the agent adapter can name the host (agent) process, stop once it is gone.
  if (hostPid) {
    timers.push(setInterval(() => { if (!stopping && !pidAlive(hostPid)) onHostGone(); }, opt.pidCheckMs));
  }
  timers.forEach((t) => t.unref?.());

  // ---- message handling ----
  function handle(d) {
    const m = parseDelivery(d);
    const own = d.to === BROADCAST && m.sender === cfg.user && isSelf(m.from);
    return onMessage(d, m, !seen.has(m.id) && !own);
  }

  // ---- connection loop ----
  let lost = false;
  let backoff = 1000;
  const loop = (async () => {
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
              if (lost) { lost = false; onStatus('restored'); }
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
          onStatus('lost', e?.authProblem ? transport.explainError(e).split(':')[0] : '');
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

  /** Stop receiving; `depart` also removes the presence entry. Waits briefly for pending acks. */
  function stopReceiver({ depart = false } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      stop.abort();
      streamAc?.abort();
      timers.forEach((t) => clearInterval(t));
      await Promise.race([loop, sleep(4000)]);
      if (depart) await post('depart', 2000);
      await transport.close?.().catch(() => {});
    })();
    return stopping;
  }

  return { state: () => st, commit, stop: stopReceiver };
}
