// `mbox deliverd`: one delivery daemon per profile and machine (see config.ts, state.ts). It pushes mail into agent sessions
// through each session's own endpoint (Claude Code: the session's inbox socket), so no session
// needs a waiter, a running hook or a background task.
//
//   - Sessions register through their agent's session-start hook (see registrations.ts); the
//     daemon watches that directory (fs.watch plus a slow rescan) and serves every registration
//     whose agent adapter has a `delivery` capability.
//   - Per session: the shared receiving loop (receiver.ts: durable position, broadcast cursor,
//     presence and heartbeats, alias changes), on ONE transport connection for all sessions.
//   - Mail arriving within drainMs is batched into one text and handed to
//     adapter.delivery.deliver(endpoint, text, meta). Messages are recorded as delivered (cursor +
//     recently delivered ids) and only then acknowledged, after deliver() resolved: at-least-once,
//     and a redelivery after a restart is recognised by its id and not shown again.
//   - deliver() failing: if the session's host process is gone, the registration is removed and
//     the session departs; otherwise the batch stays unacknowledged and is retried with backoff.
//   - A session whose host process is gone without its session-end hook having run gets its
//     `ended` event here (once: whichever of the hook and the daemon comes first writes it).
//   - Runaway guard: at most maxPerMin messages per session per minute; the excess stays
//     unacknowledged and follows in the next window, with one notice line in the delivery that held
//     it back. `mbox pause` holds delivery entirely (pause.ts) until `mbox resume`.
//   - Exits after idleExitMs without registrations. A second instance of the same or an older
//     version exits at once (pidfile lock, which records each daemon's version and bundle path).
//   - Version takeover: a newer daemon (started by a newer session-start hook, see ensureDeliverd)
//     waits for the older one to hand over, and terminates it after handoverMs if it does not. The
//     old one hands over gracefully on SIGTERM: it stops taking messages, finishes the delivery in
//     flight and its acknowledgement, hands back everything else unacknowledged and in order (so
//     the new daemon's receivers, on the same durable per-session positions, get it first; the
//     transport holds newer mail until it is all back, so it is shown in stream order),
//     releases the lock and exits. Delivered ids are on disk before they are acknowledged, so the
//     new daemon never shows one again.
//
// Agent-neutral: everything agent-specific comes in through `deliveryFor(agentId)`.
import fs from 'node:fs';
import { loadConfig, profileName } from './config.js';
import { formatBatch } from './envelope.js';
import { emitEnded } from './events.js';
import { isPaused, pausePath, readPause } from './pause.js';
import { openReceiver } from './receiver.js';
import type { Receiver } from './receiver.js';
import {
  deliverdInfo,
  deliverdLockPath,
  deregister,
  listRegistrations,
  registrationsDir,
  replaces,
  sameRegistration,
  settleStartClaim,
  startClaim,
  versionName,
} from './registrations.js';
import type { DaemonInfo } from './registrations.js';
import {
  acquireFileLock,
  acquireLock,
  addressUser,
  awaitExit,
  ensureSession,
  mkdirp,
  pidAlive,
  readState,
  stateDir,
  waiterPid,
} from './state.js';
import type { HeldLock } from './state.js';
import { compareVersions } from './version.js';
import type {
  Config,
  Delivery,
  DeliveryCapability,
  DeliveryResult,
  Env,
  Message,
  Registration,
  Transport,
} from './types.js';

export interface DeliverdOptions {
  drainMs: number;
  maxChars: number;
  retryMs: number;
  maxRetryMs: number;
  giveUpMs: number;
  idleExitMs: number;
  rescanMs: number;
  maxPerMin: number;
  rateWindowMs: number;
  pausePollMs: number;
  handoverMs: number;
  fault: string;
}

export function deliverdOptions(env: Env = process.env): DeliverdOptions {
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
    // How long a newer daemon waits for an older one to hand over before killing it: above the
    // receivers' settle time (receiver.ts), so a delivery in flight can finish.
    handoverMs: Number(env.AGENT_MAILBOX_HANDOVER_MS) || 20000,
    // test-only: "crash-after-deliver" | "crash-after-commit" | "ignore-sigterm" (a daemon that
    // will not hand over)
    fault: env.AGENT_MAILBOX_FAULT || '',
  };
}

/** A concise log: one timestamped line per event, rotated to <file>.1 past maxBytes. */
export function fileLog(file: string, maxBytes = 256 * 1024): (msg: string) => void {
  return (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      try {
        if (fs.statSync(file).size + line.length > maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no log yet */
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      /* logging must never break delivery */
    }
  };
}

const handled = (e: Error): Promise<never> => {
  const p = Promise.reject(e);
  p.catch(() => {});
  return p;
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errCode = (e: unknown): string => {
  const x = e as { code?: unknown; message?: unknown } | null | undefined;
  return String(x?.code || x?.message || e).slice(0, 120);
};

/** A delivery waiting in a worker, with the settle functions of its deferred acknowledgement. */
interface PendingEntry {
  delivery: Delivery;
  message: Message;
  fresh: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** One registered session being served. */
interface Worker {
  sid: string;
  /** The registration as last seen. */
  readonly reg: Registration;
  update(next: Registration): void;
  stop(opts?: { depart?: boolean }): Promise<void>;
  /** The pause state changed: deliver what is waiting. */
  kick(): void;
}

export interface RunDeliverdInput {
  cfg: Config;
  /** Should be created with `multiplex: true`: all sessions share its connection. */
  transport: Transport;
  deliveryFor: (agentId: string) => DeliveryCapability | null;
  /** This daemon's version and the bundle it runs from, recorded in the lock file. */
  version: string;
  exe: string;
  env?: Env;
  /** One concise line per event; never given endpoints or other secrets. */
  log?: (line: string) => void;
  /**
   * Start a daemon for this profile again (the client config changed while this one ran, see
   * below); called once this one has released its lock.
   */
  restart?: () => void;
}

/** Do two configs name the same identity on the same servers? */
const sameIdentity = (a: Config, b: Config): boolean =>
  a.user === b.user &&
  a.password === b.password &&
  JSON.stringify(a.servers) === JSON.stringify(b.servers);

/**
 * @param deliveryFor (agentId) -> {kind, deliver(endpoint, text, meta)} | null
 * @param log         (line) -> void; never given endpoints or other secrets
 * @returns exit code
 */
export async function runDeliverd({
  cfg,
  transport,
  deliveryFor,
  version,
  exe,
  env = process.env,
  log = () => {},
  restart = () => {},
}: RunDeliverdInput): Promise<number> {
  const opt = deliverdOptions(env);
  mkdirp(stateDir(env));
  const acquired = await acquireDaemonLock({
    version,
    exe,
    user: cfg.user,
    env,
    log,
    handoverMs: opt.handoverMs,
  });
  if (!acquired) {
    await transport.close?.().catch(() => {});
    return 0;
  }
  const lock = acquired; // narrowed to the held lock, which function declarations below rely on
  settleStartClaim(version, env);
  log(`started (pid ${process.pid}, version ${version})`);

  /**
   * The session's process is gone and no session-end hook ran (a crash, a closed terminal): write
   * its `ended` event, unless the hook already did (emitEnded writes it once per start).
   */
  function orphanEnded(sid: string, address: string): void {
    const st = readState(sid, env);
    if (!st) return;
    void emitEnded(transport, st, { cfg, sid, env }).then((err) => {
      if (err) log(`${address}: could not write the ended event (${transport.explainError(err)})`);
    });
  }
  const profile = profileName(env);
  log(`mailbox user ${cfg.user}${profile ? `, profile ${profile}` : ''}`);
  mkdirp(registrationsDir(env));

  const workers = new Map<string, Worker>();
  const noted = new Set<string>(); // one-time log notes
  const lost = new Set<string>(); // sids whose connection is down (log transitions once)
  let idleSince: number | null = Date.now();
  let pauseState = readPause(env);
  let stopping = false;
  let doneResolve!: (code: number) => void;
  const done = new Promise<number>((r) => (doneResolve = r));
  const timers: Array<ReturnType<typeof setInterval>> = [];

  const note = (key: string, msg: string): void => {
    if (noted.has(key)) return;
    noted.add(key);
    log(msg);
  };

  function createWorker(reg: Registration, cap: DeliveryCapability): Worker {
    const sid = reg.sid;
    let current = reg;
    let rx: Receiver | null = null;
    let sessLock: HeldLock | null = null;
    let stopped: Promise<void> | null = null;
    const pending: PendingEntry[] = []; // in delivery order
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = false;
    const inflight = new Set<string>(); // ids of the fresh messages taken out of `pending` by the flush under way
    let backoff = opt.retryMs;
    let failingSince: number | null = null;
    let failures = 0;
    let lastErr = '';
    let pausedNoted = false;
    let noticed = false; // a throttling notice went out in this episode
    let owedNotice = false; // mail was held by the rate limit with no delivery to say so yet
    const sent: number[] = []; // delivery times of recently delivered messages (rate window)
    const addr = () => rx?.state().address || current.address;
    const names = () => (rx ? [rx.state().address, ...rx.state().aliases] : [current.address]);

    const w: Worker = {
      sid,
      update,
      stop,
      kick,
      get reg() {
        return current;
      },
    };

    /** ms until the rate window has room again (0 if it has room now). */
    function windowWait(now = Date.now()): number {
      while (sent.length && sent[0]! <= now - opt.rateWindowMs) sent.shift(); // non-empty: checked first
      return sent.length >= opt.maxPerMin ? sent[0]! + opt.rateWindowMs - now + 5 : 0; // maxPerMin >= 1 here, so non-empty
    }

    function schedule(delayMs = opt.drainMs): void {
      if (stopped || flushing || retryTimer || drainTimer) return;
      if (!pending.some((p) => p.fresh)) return;
      const wait = windowWait();
      if (wait > 0 && !noticed) owedNotice = true; // held by the rate limit: say so when it goes out
      drainTimer = setTimeout(
        () => {
          drainTimer = undefined;
          void flush();
        },
        Math.max(delayMs, wait),
      );
    }

    /** Pause state changed: deliver what is waiting (or note the pause). */
    function kick(): void {
      if (stopped || flushing || retryTimer) return;
      clearTimeout(drainTimer);
      drainTimer = undefined;
      schedule(0);
    }

    function onMessage(d: Delivery, m: Message, fresh: boolean): DeliveryResult {
      if (stopped) return { ackAfter: handled(new Error('not delivered')) };
      // Nothing waiting and nothing to show (a redelivery, our own broadcast): record, ack now.
      if (!fresh && !pending.length && !flushing) {
        rx!.commit([{ delivery: d, message: m }]);
        return undefined;
      }
      // Redelivered while waiting, or while its delivery is in flight (not yet recorded as seen).
      if (fresh && (inflight.has(m.id) || pending.some((p) => p.fresh && p.message.id === m.id)))
        fresh = false;
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const ackAfter = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      ackAfter.catch(() => {});
      pending.push({ delivery: d, message: m, fresh, resolve, reject });
      if (pending.length >= 500 && !flushing && !retryTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
        void flush();
      } else schedule();
      return { ackAfter };
    }

    async function flush(): Promise<void> {
      if (flushing || stopped || !rx) return;
      const address = addr();
      if (isPaused(pauseState, names())) {
        if (!pausedNoted)
          log(`${address}: delivery paused (${pending.filter((p) => p.fresh).length} waiting)`);
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
      for (const p of all) if (p.fresh) inflight.add(p.message.id);
      // Runaway guard: at most the window's remaining room of fresh messages in this delivery.
      const room = opt.maxPerMin - sent.length;
      let cut = all.length;
      for (let i = 0, n = 0; i < all.length; i++)
        if (all[i]!.fresh && ++n > room) {
          cut = i;
          break;
        }
      const items = all.slice(0, cut);
      const held = all.slice(cut);
      const heldFresh = held.filter((p) => p.fresh).length;
      const fitted = formatBatch(items, {
        address,
        maxChars: opt.maxChars,
        note: '',
        later: 'in the next delivery',
      });
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
        const meta = {
          sid,
          address,
          count: shown,
          ids: msgs.map((m) => m.id),
          senders: [...new Set(msgs.map((m) => m.from))],
        };
        try {
          await cap.deliver(current.endpoint, text, meta);
        } catch (e) {
          flushing = false;
          pending.unshift(...items);
          inflight.clear();
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
      if (text)
        log(
          `delivered ${plural(shown, 'message')} to ${address}${failingSince ? ` (after ${plural(failures, 'failed attempt')})` : ''}`,
        );
      failingSince = null;
      failures = 0;
      lastErr = '';
      backoff = opt.retryMs;
      flushing = false;
      inflight.clear();
      if (stopped) {
        for (const p of [...rest, ...pending.splice(0)]) p.reject(new Error('not delivered'));
        return undefined;
      }
      pending.unshift(...rest);
      schedule(rest.length ? 0 : opt.drainMs);
      return undefined;
    }

    function failed(e: unknown): void {
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
        log(
          `${addr()}: delivery failing for ${Math.round((Date.now() - failingSince) / 60000)} min (${code}) and the session's process is unknown; deregistered`,
        );
        deregister(sid, env, { only: current });
        void stop({ depart: true });
        return;
      }
      if (code !== lastErr || failures % 10 === 1)
        log(
          `${addr()}: delivery failed (${code}); retrying in ${Math.round(backoff / 100) / 10}s, unacknowledged`,
        );
      lastErr = code;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void flush();
      }, backoff);
      backoff = Math.min(backoff * 2, opt.maxRetryMs);
    }

    function hostGone() {
      if (stopped) return;
      if (current.hostPid && pidAlive(current.hostPid)) return; // a stale check against an older registration
      log(`${addr()}: session process ${current.hostPid ?? '?'} is gone; deregistered`);
      deregister(sid, env, { only: current });
      orphanEnded(sid, addr());
      void stop({ depart: true });
    }

    function update(next: Registration): void {
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
        retryTimer = undefined;
        backoff = opt.retryMs;
        void flush();
      }
    }

    function stop({ depart = false } = {}) {
      if (stopped) return stopped;
      stopped = (async () => {
        clearTimeout(drainTimer);
        clearTimeout(retryTimer);
        // Take no more messages (synchronous), then hand back what waits: it stays on the server,
        // in order, for whoever serves the session next. A delivery in flight finishes first and
        // is acknowledged; flush() then hands back what came after it.
        const receiving = rx?.stop({ depart });
        if (!flushing) for (const p of pending.splice(0)) p.reject(new Error('not delivered'));
        lost.delete(sid);
        await receiving;
        sessLock?.release();
        if (workers.get(sid) === w) workers.delete(sid);
        if (rx) log(`stopped serving ${addr()}${depart ? '' : ' (still registered)'}`);
      })();
      return stopped;
    }

    async function start() {
      const got = acquireLock(sid, env);
      if (!got.ok) {
        note(
          `watched:${sid}`,
          `${current.address}: already received by another process (pid ${got.pid}, e.g. mbox watch); not serving it`,
        );
        sessLock = null;
        if (workers.get(sid) === w) workers.delete(sid);
        stopped = Promise.resolve();
        return;
      }
      sessLock = got;
      noted.delete(`watched:${sid}`);
      // A `mbox wait` for this session sees our lock and steps aside; let it finish first.
      const waiter = waiterPid(sid, env);
      if (waiter) await awaitExit(waiter, 10000);
      try {
        const st =
          readState(sid, env) ||
          (await ensureSession({
            sid,
            cfg,
            transport,
            cwd: current.cwd || stateDir(env),
            hostPid: current.hostPid,
            env,
          }));
        if (stopped) return;
        rx = await openReceiver({
          cfg,
          transport,
          sid,
          st,
          agent: current.agent,
          hostPid: current.hostPid,
          env,
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
          onReaddressed(address) {
            // Under another user now: this daemon's credentials cannot read it (scan says so).
            log(`${current.address}: this session's address is now ${address}; stopped serving it`);
            void stop({ depart: false });
          },
          onServiceLost(service) {
            log(`${current.address}: another session holds ${service} now; stopped reading it`);
          },
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
    if (configChanged()) return;
    const regs = listRegistrations(env);
    const present = new Set();
    for (const reg of regs) {
      const cap = deliveryFor(reg.agent);
      if (!cap || cap.kind !== reg.endpoint.kind) {
        note(
          `nocap:${reg.sid}`,
          `${reg.address}: no delivery for agent "${reg.agent}" endpoint kind "${String(reg.endpoint.kind)}"; skipped`,
        );
        continue;
      }
      present.add(reg.sid);
      const w = workers.get(reg.sid);
      if (w) {
        w.update(reg);
        continue;
      }
      if (reg.hostPid && !pidAlive(reg.hostPid)) {
        if (deregister(reg.sid, env, { only: reg })) {
          log(`${reg.address}: session process ${reg.hostPid} is gone; deregistered`);
          orphanEnded(reg.sid, reg.address);
        }
        present.delete(reg.sid);
        continue;
      }
      // A session whose address belongs to another user (registered before this profile's mailbox
      // user was changed): these credentials cannot read its mail. Its next mbox command or a
      // restart gives it an address under this user (ensureSession); until then it is not served,
      // and it does not keep this daemon from going idle.
      const own = readState(reg.sid, env)?.address ?? reg.address;
      const owner = addressUser(own);
      if (owner !== cfg.user) {
        note(
          `foreign:${reg.sid}:${own}`,
          `${own}: belongs to user ${owner ?? '?'}, but this deliverd runs as user ${cfg.user}; not serving it (restart that session, or run an mbox command in it, to give it an address under ${cfg.user})`,
        );
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

  /**
   * Has the client config been changed to another identity (`mbox setup` while this daemon ran)?
   * Then this daemon stops and starts a new one, which reads the new config: one daemon serves one
   * profile, and this one's credentials no longer match what the profile's sessions use.
   */
  let restartAfterStop = false;
  function configChanged(): boolean {
    let now: Config;
    try {
      now = loadConfig(env);
    } catch {
      return false; // unreadable for a moment, or removed: keep serving with what we have
    }
    if (sameIdentity(now, cfg)) return false;
    restartAfterStop = true;
    void shutdown(
      `the client config changed (${now.user === cfg.user ? 'servers or password' : `user ${cfg.user} -> ${now.user}`}); restarting`,
    );
    return true;
  }

  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  function scanSoon(ms = 100): void {
    if (scanTimer || stopping) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, ms);
  }

  async function shutdown(why: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    const next = handoverTarget(version, env);
    log(`stopping (${why}${next ? `; handing over to ${next}` : ''})`);
    if (scanTimer) clearTimeout(scanTimer);
    timers.forEach((t) => clearInterval(t));
    try {
      watcher?.close();
    } catch {
      /* */
    }
    await Promise.all([...workers.values()].map((w) => w.stop({ depart: false })));
    lock.release();
    await transport.close?.().catch(() => {});
    log(`stopped (pid ${process.pid}, version ${version})`);
    if (restartAfterStop) {
      try {
        restart();
      } catch (e) {
        log(`could not start a new deliverd (${errCode(e)})`);
      }
    }
    doneResolve(0);
  }

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(registrationsDir(env), () => scanSoon());
    watcher.on('error', () => {});
  } catch {
    /* the slow rescan still covers it */
  }
  timers.push(setInterval(scan, opt.rescanMs));
  // `mbox pause` / `mbox resume`: re-read the pause file when it changes.
  let pauseSig = '';
  timers.push(
    setInterval(() => {
      let sig: string;
      try {
        sig = String(fs.statSync(pausePath(env)).mtimeMs);
      } catch {
        sig = 'none';
      }
      if (sig === pauseSig) return;
      const first = pauseSig === '';
      pauseSig = sig;
      pauseState = readPause(env);
      if (first) return;
      log(
        pauseState.all
          ? 'delivery paused for all sessions'
          : pauseState.addresses.length
            ? `delivery paused for ${pauseState.addresses.join(', ')}`
            : 'delivery not paused',
      );
      for (const w of workers.values()) w.kick();
    }, opt.pausePollMs),
  );
  timers.push(
    setInterval(
      () => {
        lock.touch();
        if (
          !stopping &&
          idleSince !== null &&
          !workers.size &&
          Date.now() - idleSince >= opt.idleExitMs
        )
          void shutdown('idle');
      },
      Math.max(50, Math.min(5000, Math.floor(opt.idleExitMs / 4))),
    ),
  );
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.on(sig, () => {
      if (sig === 'SIGTERM' && opt.fault === 'ignore-sigterm') {
        log('ignoring SIGTERM (test fault)');
        return;
      }
      void shutdown(sig);
    });
  scan();
  return done;
}

/** The version of a newer daemon that is about to take over from this one, else null. */
function handoverTarget(version: string, env: Env): string | null {
  const next = startClaim(env);
  return next &&
    next.pid !== process.pid &&
    pidAlive(next.pid) &&
    compareVersions(next.version, version) > 0
    ? next.version
    : null;
}

interface AcquireDaemonLockInput {
  version: string;
  exe: string;
  /** The mailbox user it serves, recorded for `mbox deliverd --status` and `mbox doctor`. */
  user: string;
  env: Env;
  log: (line: string) => void;
  handoverMs: number;
}

/**
 * The daemon lock, or null when this daemon should exit. A daemon of the same or a newer version
 * keeps it (this one exits). An older one is asked to hand over (SIGTERM; the hook that started
 * this daemon usually asked already) and waited for; if it has not exited after handoverMs, it is
 * killed and its abandoned lock taken. SIGTERM while waiting ends the wait.
 */
async function acquireDaemonLock({
  version,
  exe,
  user,
  env,
  log,
  handoverMs,
}: AcquireDaemonLockInput): Promise<HeldLock | null> {
  const file = deliverdLockPath(env);
  // The daemon the starting hook asked to hand over (it may be gone before this one looks).
  const claim = startClaim(env);
  const askedFrom = claim?.version === version ? claim.from : null;
  let interrupted = '';
  const onSignal = (sig: string): void => {
    interrupted = sig;
  };
  const sigs = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const handlers = sigs.map((sig) => [sig, () => onSignal(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  let waitingFor: DaemonInfo | null = null;
  let since = 0;
  let killed = false;
  try {
    for (;;) {
      if (interrupted) {
        log(`not started (${interrupted} while waiting for the lock)`);
        return null;
      }
      const got = acquireFileLock(file, { version, exe, user });
      if (got.ok) {
        const prev = waitingFor ?? askedFrom;
        if (prev)
          log(
            `deliverd ${versionName(prev.version)} (pid ${prev.pid}) ${killed ? 'was terminated' : 'exited'}; taking over`,
          );
        return got;
      }
      const holder = deliverdInfo(env);
      if (!holder) {
        await sleep(50); // released in between: try again
        continue;
      }
      if (!replaces({ version, user }, holder)) {
        log(`another deliverd is running (pid ${holder.pid}); exiting`);
        return null;
      }
      if (waitingFor?.pid !== holder.pid) {
        waitingFor = holder;
        since = Date.now();
        killed = false;
        log(
          `waiting for deliverd ${versionName(holder.version)} (pid ${holder.pid}) to hand over to ${version}`,
        );
        signal(holder.pid, 'SIGTERM'); // idempotent: the starting hook normally asked already
      } else if (!killed && Date.now() - since >= handoverMs) {
        log(
          `deliverd ${versionName(holder.version)} (pid ${holder.pid}) did not exit within ${Math.round(handoverMs / 1000)} s; terminating it (SIGKILL)`,
        );
        signal(holder.pid, 'SIGKILL');
        killed = true;
      }
      await sleep(100);
    }
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}
