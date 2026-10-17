// Sessions registered for push delivery by `mbox deliverd`, one file per session, and the daemon's
// singleton lock. Agent-neutral: an agent adapter's session-start hook writes the registration
// (with the endpoint its `delivery.endpointFromHook` found), its session-end hook removes it.
//
//   <state>/registrations/<sid>.json   {sid, address, endpoint, hostPid, cwd, agent, registeredAt}
//                                      mode 0600 (the endpoint may hold a secret, e.g. a token)
//   <state>/deliverd.lock              the running daemon (pidfile lock: {pid, startedAt, version, exe})
//   <state>/deliverd.starting          a daemon is being started: {pid, version, at} (see ensureDeliverd)
//   <state>/deliverd.log               its concise, rotating log (never endpoints or tokens)
//   <state>/deliverd.out               its stdout/stderr (crash traces only)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  lockHolder,
  lockInfo,
  mkdirp,
  pidAlive,
  readJson,
  stateDir,
  validateSessionId,
} from './state.js';
import { compareVersions } from './version.js';
import type { Env, Registration, RegistrationInput } from './types.js';

export const registrationsDir = (env: Env = process.env): string =>
  path.join(stateDir(env), 'registrations');
export const registrationPath = (sid: string, env: Env = process.env): string =>
  path.join(registrationsDir(env), `${validateSessionId(sid)}.json`);
export const deliverdLockPath = (env: Env = process.env): string =>
  path.join(stateDir(env), 'deliverd.lock');
export const deliverdLogPath = (env: Env = process.env): string =>
  path.join(stateDir(env), 'deliverd.log');
const deliverdOutPath = (env: Env): string => path.join(stateDir(env), 'deliverd.out');
const startClaimPath = (env: Env): string => path.join(stateDir(env), 'deliverd.starting');

function privateDir(dir: string): void {
  mkdirp(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to change */
  }
}

/** Write (or replace) a session's registration, mode 0600. */
export function register(
  { sid, address, endpoint, hostPid = null, cwd = null, agent }: RegistrationInput,
  env: Env = process.env,
): Registration {
  privateDir(stateDir(env));
  privateDir(registrationsDir(env));
  const file = registrationPath(sid, env);
  const reg: Registration = {
    sid,
    address,
    endpoint,
    hostPid: hostPid || null,
    cwd,
    agent,
    registeredAt: new Date().toISOString(),
  };
  atomicWriteJson(file, reg);
  fs.chmodSync(file, 0o600);
  return reg;
}

/** Remove a session's registration; with `only`, only while it still names that endpoint and host. */
export function deregister(
  sid: string,
  env: Env = process.env,
  { only = null }: { only?: Registration | null } = {},
): boolean {
  let file: string;
  try {
    file = registrationPath(sid, env);
  } catch {
    return false;
  }
  if (only) {
    const cur = readJson(file);
    if (!cur || !sameRegistration(cur, only)) return false;
  }
  try {
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The part of a registration that says which process and endpoint it names. */
export interface RegistrationIdentity {
  endpoint?: unknown;
  hostPid?: unknown;
}

export const sameRegistration = (a: RegistrationIdentity, b: RegistrationIdentity): boolean =>
  JSON.stringify(a.endpoint) === JSON.stringify(b.endpoint) &&
  (a.hostPid || null) === (b.hostPid || null);

/** Valid registrations on disk: [{sid, address, endpoint, hostPid, cwd, agent}]. */
export function listRegistrations(env: Env = process.env): Registration[] {
  let names: string[];
  try {
    names = fs.readdirSync(registrationsDir(env));
  } catch {
    return [];
  }
  const out: Registration[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const r = readJson(path.join(registrationsDir(env), n));
    if (
      !r ||
      typeof r.sid !== 'string' ||
      `${r.sid}.json` !== n ||
      typeof r.address !== 'string' ||
      !r.endpoint ||
      typeof r.endpoint !== 'object' ||
      typeof r.agent !== 'string'
    )
      continue;
    const pid = Number(r.hostPid);
    // sid, address, endpoint and agent are checked above; cwd and registeredAt were written by register().
    out.push({
      ...r,
      hostPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    } as unknown as Registration);
  }
  return out;
}

/** pid of the running delivery daemon, else null. */
export const deliverdPid = (env: Env = process.env): number | null =>
  lockHolder(deliverdLockPath(env));

/** The running delivery daemon, as its lock file describes it. */
export interface DaemonInfo {
  pid: number;
  /** Its version; null for a daemon from before 0.5.3, which did not record one. */
  version: string | null;
  /** The bundle it runs from (the file may since have been deleted); null before 0.5.3. */
  exe: string | null;
}

/** The running delivery daemon, else null. */
export function deliverdInfo(env: Env = process.env): DaemonInfo | null {
  const info = lockInfo(deliverdLockPath(env));
  if (!info || typeof info.pid !== 'number') return null;
  return {
    pid: info.pid,
    version: typeof info.version === 'string' ? info.version : null,
    exe: typeof info.exe === 'string' ? info.exe : null,
  };
}

/** A version for log lines: "0.5.3", or "(before 0.5.3)" for a daemon that recorded none. */
export const versionName = (v: string | null): string => v ?? '(before 0.5.3)';

/** How long a start claim counts at most, even while its process lives. */
const START_CLAIM_MS = 60000;

export interface StartClaim {
  /** The starting process, then the daemon it started. */
  pid: number;
  version: string | null;
  at: number;
  /** The older daemon asked to hand over, if any. */
  from: { pid: number; version: string | null } | null;
}

/** The current start claim, if any (live or not). */
export function startClaim(env: Env = process.env): StartClaim | null {
  const c = readJson(startClaimPath(env));
  if (!c || typeof c.pid !== 'number' || typeof c.at !== 'number') return null;
  const f = c.from as { pid?: unknown; version?: unknown } | null | undefined; // untrusted: checked
  return {
    pid: c.pid,
    version: typeof c.version === 'string' ? c.version : null,
    at: c.at,
    from:
      f && typeof f.pid === 'number'
        ? { pid: f.pid, version: typeof f.version === 'string' ? f.version : null }
        : null,
  };
}

/**
 * Claim the right to start a daemon of `version`: false when a live claim for the same or a newer
 * version exists (that daemon will serve every registration), so sessions starting together start
 * one daemon. A claim is live while its process runs, for at most START_CLAIM_MS.
 */
function claimStart(env: Env, version: string, from: DaemonInfo | null): boolean {
  const file = startClaimPath(env);
  const mine: StartClaim = {
    pid: process.pid,
    version,
    at: Date.now(),
    from: from && { pid: from.pid, version: from.version },
  };
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.new`;
  fs.writeFileSync(tmp, JSON.stringify(mine) + '\n', { mode: 0o600 });
  try {
    fs.linkSync(tmp, file); // exclusive: of two starters, one gets here
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const cur = startClaim(env);
  if (
    cur &&
    pidAlive(cur.pid) &&
    Date.now() - cur.at < START_CLAIM_MS &&
    compareVersions(cur.version, version) >= 0
  )
    return false;
  atomicWriteJson(file, mine); // abandoned, or for an older version: ours now
  return true;
}

/** Hand this process's start claim to the daemon it spawned (pid). */
function passStartClaim(env: Env, pid: number): void {
  const cur = startClaim(env);
  if (cur?.pid === process.pid) atomicWriteJson(startClaimPath(env), { ...cur, pid });
}

/** Drop this process's start claim (the spawn failed). */
function dropStartClaim(env: Env): void {
  if (startClaim(env)?.pid === process.pid) fs.rmSync(startClaimPath(env), { force: true });
}

/**
 * The daemon holds the lock now: a start claim for its version or an older one is settled. A claim
 * for a newer version stays (that daemon is about to take over).
 */
export function settleStartClaim(version: string, env: Env = process.env): void {
  const cur = startClaim(env);
  if (cur && compareVersions(cur.version, version) <= 0)
    fs.rmSync(startClaimPath(env), { force: true });
}

export interface EnsureDeliverdOptions {
  /** Variables the daemon must not inherit. */
  dropEnv?: string[];
  /** The version of the daemon `argv` starts (this build's). */
  version: string;
  /** deliverd.log, for the handover request. */
  log?: (line: string) => void;
}

/**
 * Make sure a delivery daemon of `version` or newer serves this machine. `argv` = [executable,
 * ...args] runs `mbox deliverd`. Nothing happens when one of the same or a newer version runs (never
 * a downgrade). When none runs, or an older one, it starts the daemon detached (own process
 * group, stdio to a file, not waited for); an older daemon is first asked to hand over (SIGTERM,
 * which every version treats as a graceful stop), and the new daemon waits for it to exit (see
 * runDeliverd), so the caller never blocks. A start claim keeps sessions that start together from
 * starting several daemons, and the daemon's own lock settles any race that remains. Returns the
 * new pid, or null when none was started.
 */
export function ensureDeliverd(
  argv: string[],
  env: Env = process.env,
  { dropEnv = [], version, log = () => {} }: EnsureDeliverdOptions,
): number | null {
  const running = deliverdInfo(env);
  if (running && compareVersions(version, running.version) <= 0) return null;
  const [command, ...args] = argv;
  if (!command) throw new TypeError('ensureDeliverd: argv must start with the executable');
  privateDir(stateDir(env));
  if (!claimStart(env, version, running)) return null;
  try {
    if (running) {
      log(
        `handover requested: deliverd ${versionName(running.version)} (pid ${running.pid}) -> ${version}`,
      );
      try {
        process.kill(running.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const outFile = deliverdOutPath(env);
    const fd = fs.openSync(outFile, 'w', 0o600); // truncated: it only holds the latest run's traces
    try {
      // The daemon serves every session: it must not inherit one session's identity or secrets
      // (the caller names them: AGENT_MAILBOX_SESSION plus each adapter's delivery.sessionEnv).
      const childEnv = { ...env };
      for (const k of dropEnv) delete childEnv[k];
      const child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: childEnv,
        cwd: stateDir(env),
      });
      child.on('error', () => {}); // reported by the missing daemon, not by crashing the caller
      child.unref();
      if (child.pid) passStartClaim(env, child.pid);
      else dropStartClaim(env);
      return child.pid ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    dropStartClaim(env);
    throw e;
  }
}
