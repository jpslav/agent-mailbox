// `mbox deliverd`: one delivery daemon per user and machine. It pushes mail into agent sessions
// through each session's own endpoint (Claude Code: the session's inbox socket), so no session
// needs a waiter, a running hook or a background task.
//
//   - Sessions register through their agent's session-start hook (see registrations.js); the
//     daemon watches that directory (fs.watch plus a slow rescan) and serves every registration
//     whose agent adapter has a `delivery` capability.
//   - Per session: the shared receiving loop (receiver.js: durable position, broadcast cursor,
//     presence and heartbeats, alias changes), on ONE transport connection for all sessions.
//   - Mail arriving within drainMs is batched into one text and handed to
//     adapter.delivery.deliver(endpoint, text, meta). Messages are recorded as delivered (cursor +
//     recently delivered ids) and only then acknowledged, after deliver() resolved: at-least-once,
//     and a redelivery after a restart is recognised by its id and not shown again.
//   - deliver() failing: if the session's host process is gone, the registration is removed and
//     the session departs; otherwise the batch stays unacknowledged and is retried with backoff.
//   - Runaway guard: at most maxPerMin messages per session per minute; the excess stays
//     unacknowledged and follows in the next window, with one notice line in the delivery that held
//     it back. `mbox pause` holds delivery entirely (pause.js) until `mbox resume`.
//   - Exits after idleExitMs without registrations. A second instance exits at once (pidfile lock).
//
// Agent-neutral: everything agent-specific comes in through `deliveryFor(agentId)`.
import fs from 'node:fs';
import { formatBatch } from './envelope.js';
import { isPaused, pausePath, readPause } from './pause.js';
import { openReceiver } from './receiver.js';
import { deliverdLockPath, deregister, listRegistrations, registrationsDir, sameRegistration } from './registrations.js';
import { acquireFileLock, acquireLock, awaitExit, ensureSession, mkdirp, pidAlive, readState, stateDir, waiterPid } from './state.js';

export function deliverdOptions(env = process.env) {
  return {
    drainMs: Number(env.AGENT_MAILBOX_DRAIN_MS) || 300,
    maxChars: Number(env.AGENT_MAILBOX_DELIVER_MAX_CHARS) || 8000,
    retryMs: Number(env.AGENT_MAILBOX_DELIVER_RETRY_MS) || 1000,
    maxRetryMs: Number(env.AGENT_MAILBOX_DELIVER_MAX_RETRY_MS) || 60000,
    giveUpMs: Number(env.AGENT_MAILBOX_DELIVER_GIVE_UP_MS) || 3600000, // only for sessions without a host pid
    idleExitMs: Number(env.AGENT_MAILBOX_DELIVERD_IDLE_MS) || 600000,
    rescanMs: Number(env.AGENT_MAILBOX_DELIVERD_RESCAN_MS) || 30000,
    maxPerMin: Number(env.AGENT_MAILBOX_MAX_PER_MIN) || 30,
    rateWindowMs: Number(env.AGENT_MAILBOX_RATE_WINDOW_MS) || 60000, // test hook; "per minute"
    pausePollMs: Number(env.AGENT_MAILBOX_PAUSE_POLL_MS) || 1000,
    fault: env.AGENT_MAILBOX_FAULT || '', // test-only: "crash-after-deliver" | "crash-after-commit"
  };
}

/** A concise log: one timestamped line per event, rotated to <file>.1 past maxBytes. */
export function fileLog(file, maxBytes = 256 * 1024) {
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      try {
        if (fs.statSync(file).size + line.length > maxBytes) fs.renameSync(file, `${file}.1`);
      } catch { /* no log yet */ }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* logging must never break delivery */ }
  };
}

const handled = (e) => {
  const p = Promise.reject(e);
  p.catch(() => {});
  return p;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const errCode = (e) => String(e?.code || e?.message || e).slice(0, 120);

/**
 * @param deliveryFor (agentId) -> {kind, deliver(endpoint, text, meta)} | null
 * @param log         (line) -> void; never given endpoints or other secrets
 * @returns exit code
 */
export async function runDeliverd({ cfg, transport, deliveryFor, env = process.env, log = () => {} }) {
  const opt = deliverdOptions(env);
  mkdirp(stateDir(env));
  const lock = acquireFileLock(deliverdLockPath(env));
  if (!lock.ok) {
    log(`another deliverd is running (pid ${lock.pid}); exiting`);
    await transport.close?.().catch(() => {});
    return 0;
  }
  log(`started (pid ${process.pid})`);
  mkdirp(registrationsDir(env));

  const workers = new Map(); // sid -> worker
  const noted = new Set(); // one-time log notes
  const lost = new Set(); // sids whose connection is down (log transitions once)
  let idleSince = Date.now();
  let pauseState = readPause(env);
  let stopping = false;
  let doneResolve;
  const done = new Promise((r) => (doneResolve = r));
  const timers = [];

  const note = (key, msg) => {
    if (noted.has(key)) return;
    noted.add(key);
    log(msg);
  };

  function createWorker(reg, cap) {
    const sid = reg.sid;
    let current = reg;
    let rx = null;
    let sessLock = null;
    let stopped = null;
    const pending = []; // [{delivery, message, fresh, resolve, reject}] in delivery order
    let drainTimer = null;
    let retryTimer = null;
    let flushing = false;
    let backoff = opt.retryMs;
    let failingSince = null;
    let failures = 0;
    let lastErr = '';
    let pausedNoted = false;
    let noticed = false; // a throttling notice went out in this episode
    let owedNotice = false; // mail was held by the rate limit with no delivery to say so yet
    const sent = []; // delivery times of recently delivered messages (rate window)
    const addr = () => rx?.state().address || current.address;
    const names = () => (rx ? [rx.state().address, ...rx.state().aliases] : [current.address]);

    const w = { sid, update, stop, kick, get reg() { return current; } };

    /** ms until the rate window has room again (0 if it has room now). */
    function windowWait(now = Date.now()) {
      while (sent.length && sent[0] <= now - opt.rateWindowMs) sent.shift();
      return sent.length >= opt.maxPerMin ? sent[0] + opt.rateWindowMs - now + 5 : 0;
    }

    function schedule(delayMs = opt.drainMs) {
      if (stopped || flushing || retryTimer || drainTimer) return;
      if (!pending.some((p) => p.fresh)) return;
      const wait = windowWait();
      if (wait > 0 && !noticed) owedNotice = true; // held by the rate limit: say so when it goes out
      drainTimer = setTimeout(() => { drainTimer = null; void flush(); }, Math.max(delayMs, wait));
    }

    /** Pause state changed: deliver what is waiting (or note the pause). */
    function kick() {
      if (stopped || flushing || retryTimer) return;
      clearTimeout(drainTimer);
      drainTimer = null;
      schedule(0);
    }

    function onMessage(d, m, fresh) {
      if (stopped) return { ackAfter: handled(new Error('not delivered')) };
      // Nothing waiting and nothing to show (a redelivery, our own broadcast): record, ack now.
      if (!fresh && !pending.length && !flushing) {
        rx.commit([{ delivery: d, message: m }]);
        return undefined;
      }
      if (fresh && pending.some((p) => p.fresh && p.message.id === m.id)) fresh = false; // redelivered while waiting
      let resolve;
      let reject;
      const ackAfter = new Promise((res, rej) => { resolve = res; reject = rej; });
      ackAfter.catch(() => {});
      pending.push({ delivery: d, message: m, fresh, resolve, reject });
      if (pending.length >= 500 && !flushing && !retryTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
        void flush();
      } else schedule();
      return { ackAfter };
    }

    async function flush() {
      if (flushing || stopped || !rx) return;
      const address = addr();
      if (isPaused(pauseState, names())) {
        if (!pausedNoted) log(`${address}: delivery paused (${pending.filter((p) => p.fresh).length} waiting)`);
        pausedNoted = true;
        return; // kick() on resume
      }
      if (pausedNoted) log(`${address}: delivery resumed`);
      pausedNoted = false;
      const wait = windowWait();
      if (wait > 0) {
        if (!noticed) owedNotice = true;
        schedule(wait);
        return;
      }
      flushing = true;
      const all = pending.splice(0);
      // Runaway guard: at most the window's remaining room of fresh messages in this delivery.
      const room = opt.maxPerMin - sent.length;
      let cut = all.length;
      for (let i = 0, n = 0; i < all.length; i++) if (all[i].fresh && ++n > room) { cut = i; break; }
      const items = all.slice(0, cut);
      const held = all.slice(cut);
      const heldFresh = held.filter((p) => p.fresh).length;
      const fitted = formatBatch(items, { address, maxChars: opt.maxChars, note: '', later: 'in the next delivery' });
      const { count, shown } = fitted;
      let { text } = fitted;
      const batch = items.slice(0, count);
      const rest = [...items.slice(count), ...held];
      const mins = Math.max(1, Math.round(opt.rateWindowMs / 60000));
      const limit = `this session gets at most ${opt.maxPerMin} messages per ${mins === 1 ? 'minute' : `${mins} minutes`}`;
      let throttleNote = '';
      if (text && heldFresh && !noticed) {
        throttleNote = `[mailbox] throttling: ${limit}; ${plural(heldFresh, 'more message')} ${heldFresh === 1 ? 'is' : 'are'} held and follow${heldFresh === 1 ? 's' : ''} in the next window (or read now: mbox inbox --since 10m).\n`;
        log(`${address}: throttling, ${heldFresh} held for the next window`);
      } else if (text && owedNotice && !noticed) {
        throttleNote = `[mailbox] throttling: ${limit}; the messages above were held back to stay within it.\n`;
        log(`${address}: throttling, delivered mail held back by the rate limit`);
      }
      text += throttleNote;
      if (text) {
        const msgs = batch.filter((b) => b.fresh).map((b) => b.message);
        const meta = { sid, address, count: shown, ids: msgs.map((m) => m.id), senders: [...new Set(msgs.map((m) => m.from))] };
        try {
          await cap.deliver(current.endpoint, text, meta);
        } catch (e) {
          flushing = false;
          pending.unshift(...items);
          return failed(e);
        }
        if (opt.fault === 'crash-after-deliver') process.kill(process.pid, 'SIGKILL');
      }
      rx.commit(batch);
      if (text && opt.fault === 'crash-after-commit') process.kill(process.pid, 'SIGKILL');
      batch.forEach((b) => b.resolve());
      const t = Date.now();
      for (let i = 0; i < shown; i++) sent.push(t);
      if (throttleNote) {
        noticed = true;
        owedNotice = false;
      } else if (!heldFresh && !owedNotice) noticed = false; // the episode is over
      if (text) log(`delivered ${plural(shown, 'message')} to ${address}${failingSince ? ` (after ${plural(failures, 'failed attempt')})` : ''}`);
      failingSince = null;
      failures = 0;
      lastErr = '';
      backoff = opt.retryMs;
      flushing = false;
      if (stopped) {
        for (const p of [...rest, ...pending.splice(0)]) p.reject(new Error('not delivered'));
        return undefined;
      }
      pending.unshift(...rest);
      schedule(rest.length ? 0 : opt.drainMs);
      return undefined;
    }

    function failed(e) {
      if (stopped) {
        for (const p of pending.splice(0)) p.reject(new Error('not delivered'));
        return;
      }
      if (current.hostPid && !pidAlive(current.hostPid)) {
        hostGone();
        return;
      }
      failingSince ??= Date.now();
      failures++;
      const code = errCode(e);
      if (!current.hostPid && Date.now() - failingSince > opt.giveUpMs) {
        log(`${addr()}: delivery failing for ${Math.round((Date.now() - failingSince) / 60000)} min (${code}) and the session's process is unknown; deregistered`);
        deregister(sid, env, { only: current });
        void stop({ depart: true });
        return;
      }
      if (code !== lastErr || failures % 10 === 1) log(`${addr()}: delivery failed (${code}); retrying in ${Math.round(backoff / 100) / 10}s, unacknowledged`);
      lastErr = code;
      retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, backoff);
      backoff = Math.min(backoff * 2, opt.maxRetryMs);
    }

    function hostGone() {
      if (stopped) return;
      if (current.hostPid && pidAlive(current.hostPid)) return; // a stale check against an older registration
      log(`${addr()}: session process ${current.hostPid ?? '?'} is gone; deregistered`);
      deregister(sid, env, { only: current });
      void stop({ depart: true });
    }

    function update(next) {
      if (sameRegistration(current, next)) {
        current = next;
        return;
      }
      if ((next.hostPid || null) !== (current.hostPid || null)) {
        // A new process for the same session (resumed): start over against it.
        log(`${addr()}: re-registered by process ${next.hostPid ?? '?'}`);
        void stop({ depart: false }).then(() => scanSoon(0));
        return;
      }
      log(`${addr()}: endpoint changed`);
      current = next;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
        backoff = opt.retryMs;
        void flush();
      }
    }

    function stop({ depart = false } = {}) {
      if (stopped) return stopped;
      stopped = (async () => {
        clearTimeout(drainTimer);
        clearTimeout(retryTimer);
        if (!flushing) for (const p of pending.splice(0)) p.reject(new Error('not delivered')); // stays on the server
        lost.delete(sid);
        await rx?.stop({ depart });
        sessLock?.release();
        if (workers.get(sid) === w) workers.delete(sid);
        if (rx) log(`stopped serving ${addr()}${depart ? '' : ' (still registered)'}`);
      })();
      return stopped;
    }

    async function start() {
      sessLock = acquireLock(sid, env);
      if (!sessLock.ok) {
        note(`watched:${sid}`, `${current.address}: already received by another process (pid ${sessLock.pid}, e.g. mbox watch); not serving it`);
        sessLock = null;
        if (workers.get(sid) === w) workers.delete(sid);
        stopped = Promise.resolve();
        return;
      }
      noted.delete(`watched:${sid}`);
      // A `mbox wait` for this session sees our lock and steps aside; let it finish first.
      const waiter = waiterPid(sid, env);
      if (waiter) await awaitExit(waiter, 10000);
      try {
        const st = readState(sid, env) || (await ensureSession({ sid, cfg, transport, cwd: current.cwd || stateDir(env), hostPid: current.hostPid, env }));
        if (stopped) return;
        rx = await openReceiver({
          cfg, transport, sid, st, agent: current.agent, hostPid: current.hostPid, env,
          keepTransport: true,
          onMessage,
          onStatus(kind, hint) {
            if (kind === 'lost') {
              if (!lost.size) log(`connection lost${hint ? ` (${hint})` : ''}; retrying`);
              lost.add(sid);
            } else if (lost.delete(sid) && !lost.size) log('connection restored');
          },
          onTick: () => sessLock?.touch(),
          onHostGone: hostGone,
        });
      } catch (e) {
        log(`${current.address}: could not start (${errCode(e)}); will retry`);
        sessLock.release();
        sessLock = null;
        stopped = Promise.resolve();
        if (workers.get(sid) === w) workers.delete(sid);
        return;
      }
      if (stopped) {
        await rx.stop({ depart: false });
        return;
      }
      log(`serving ${rx.state().address}`);
    }

    workers.set(sid, w);
    void start();
    return w;
  }

  function scan() {
    if (stopping) return;
    const regs = listRegistrations(env);
    const present = new Set();
    for (const reg of regs) {
      const cap = deliveryFor(reg.agent);
      if (!cap || cap.kind !== reg.endpoint.kind) {
        note(`nocap:${reg.sid}`, `${reg.address}: no delivery for agent "${reg.agent}" endpoint kind "${String(reg.endpoint.kind)}"; skipped`);
        continue;
      }
      present.add(reg.sid);
      const w = workers.get(reg.sid);
      if (w) {
        w.update(reg);
        continue;
      }
      if (reg.hostPid && !pidAlive(reg.hostPid)) {
        if (deregister(reg.sid, env, { only: reg })) log(`${reg.address}: session process ${reg.hostPid} is gone; deregistered`);
        present.delete(reg.sid);
        continue;
      }
      createWorker(reg, cap);
    }
    for (const [sid, w] of workers) {
      if (!present.has(sid)) {
        log(`${w.reg.address}: deregistered`);
        void w.stop({ depart: true });
      }
    }
    if (present.size || workers.size) idleSince = null;
    else idleSince ??= Date.now();
  }

  let scanTimer = null;
  function scanSoon(ms = 100) {
    if (scanTimer || stopping) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, ms);
  }

  async function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    clearTimeout(scanTimer);
    timers.forEach((t) => clearInterval(t));
    try { watcher?.close(); } catch { /* */ }
    await Promise.all([...workers.values()].map((w) => w.stop({ depart: false })));
    lock.release();
    await transport.close?.().catch(() => {});
    doneResolve(0);
  }

  let watcher = null;
  try {
    watcher = fs.watch(registrationsDir(env), () => scanSoon());
    watcher.on('error', () => {});
  } catch { /* the slow rescan still covers it */ }
  timers.push(setInterval(scan, opt.rescanMs));
  // `mbox pause` / `mbox resume`: re-read the pause file when it changes.
  let pauseSig = '';
  timers.push(setInterval(() => {
    let sig = '';
    try { sig = String(fs.statSync(pausePath(env)).mtimeMs); } catch { sig = 'none'; }
    if (sig === pauseSig) return;
    const first = pauseSig === '';
    pauseSig = sig;
    pauseState = readPause(env);
    if (first) return;
    log(pauseState.all ? 'delivery paused for all sessions' : pauseState.addresses.length ? `delivery paused for ${pauseState.addresses.join(', ')}` : 'delivery not paused');
    for (const w of workers.values()) w.kick();
  }, opt.pausePollMs));
  timers.push(setInterval(() => {
    lock.touch();
    if (!stopping && idleSince !== null && !workers.size && Date.now() - idleSince >= opt.idleExitMs) void shutdown('idle');
  }, Math.max(50, Math.min(5000, Math.floor(opt.idleExitMs / 4)))));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void shutdown(sig));
  scan();
  return done;
}
