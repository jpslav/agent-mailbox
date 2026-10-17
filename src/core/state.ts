// Per-session state under ${AGENT_MAILBOX_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-mailbox}/sessions/
//   <sid>.json         identity: {address, aliases[], cwd, createdAt}
//   <sid>.cursor.json  watcher-owned: {cursor (opaque, from the transport), seen (recently printed
//                      message ids)}   (kept apart so `mbox name` and the watcher never clobber
//                      each other's writes)
//   <sid>.lock         single-receiver pidfile (`mbox watch`, or `mbox deliverd` serving the session)
//   <sid>.wait.lock    current hook waiter (`mbox wait`); the newest claim wins
import fs from 'node:fs';
import path from 'node:path';
import { defaultLabel, fitLabel, shortHost } from './addr.js';
import { xdgDir } from './config.js';
import type { Config, CursorFile, Env, SessionState, Transport } from './types.js';

export class NoSessionError extends Error {
  constructor() {
    super(
      'cannot determine the agent session id: pass --session <id>, set AGENT_MAILBOX_SESSION, ' +
        'or run inside an agent with an adapter (e.g. Claude Code, which provides CLAUDE_CODE_SESSION_ID).',
    );
  }
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function stateDir(env: Env = process.env): string {
  return (
    env.AGENT_MAILBOX_STATE_DIR ||
    path.join(xdgDir('XDG_STATE_HOME', path.join('.local', 'state'), env), 'agent-mailbox')
  );
}
const sessionsDir = (env: Env): string => path.join(stateDir(env), 'sessions');
const byPidDir = (env: Env): string => path.join(stateDir(env), 'by-pid');

export const statePath = (sid: string, env: Env = process.env): string =>
  path.join(sessionsDir(env), `${sid}.json`);
export const cursorPath = (sid: string, env: Env = process.env): string =>
  path.join(sessionsDir(env), `${sid}.cursor.json`);
export const lockPath = (sid: string, env: Env = process.env): string =>
  path.join(sessionsDir(env), `${sid}.lock`);
export const waitLockPath = (sid: string, env: Env = process.env): string =>
  path.join(sessionsDir(env), `${sid}.wait.lock`);

function validSid(sid: string): string {
  if (!SID_RE.test(sid))
    throw new Error(`invalid session id "${sid}" (allowed: letters, digits, . _ -)`);
  return sid;
}

export function validateSessionId(sid: unknown): string {
  return validSid(String(sid));
}

/** Fallback lookup: session id recorded for a host (agent) process id by an earlier command. */
export function sessionIdForHostPid(
  pid: number | null | undefined,
  env: Env = process.env,
): string | null {
  if (!pid || !/^\d+$/.test(String(pid))) return null;
  try {
    const sid = fs.readFileSync(path.join(byPidDir(env), String(pid)), 'utf8').trim();
    return sid ? validSid(sid) : null;
  } catch {
    return null;
  }
}

export function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function atomicWriteJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Create-if-absent without ever exposing a half-written file. */
function createExclusive(file: string, data: unknown): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.new`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * A JSON file's content, or null when it is missing or not JSON. These files are hand-editable
 * and can be left half-written by a crash, so the result is untrusted: callers check every field
 * they use (reading a property of a non-object yields undefined, never a crash, except on null,
 * which they guard against).
 */
export function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export function readState(sid: string, env: Env = process.env): SessionState | null {
  const s = readJson(statePath(sid, env));
  if (!s || typeof s.address !== 'string') return null;
  const aliases = Array.isArray(s.aliases)
    ? (s.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  // `address` is checked; the other fields were written by ensureSession and are not re-validated.
  return { ...s, aliases } as unknown as SessionState;
}

export function readCursor(sid: string, env: Env = process.env): CursorFile | null {
  const c = readJson(cursorPath(sid, env));
  if (!c || c.cursor === undefined || c.cursor === null) return null;
  return {
    cursor: c.cursor,
    seen: c.seen && typeof c.seen === 'object' ? (c.seen as Record<string, number>) : {},
  };
}

export function writeCursor(sid: string, cur: CursorFile, env: Env = process.env): void {
  atomicWriteJson(cursorPath(sid, env), cur);
}

/**
 * Ensure identity + cursor exist for the session. A new session starts "now" (the transport's
 * notion of the current position) so old mail is not replayed; a resumed session (same id) keeps
 * its address and cursor.
 */
export async function ensureSession({
  sid,
  cfg,
  transport,
  cwd,
  hostPid = null,
  env = process.env,
}: {
  sid: string;
  cfg: Pick<Config, 'user'>;
  transport: Pick<Transport, 'limits' | 'now'>;
  cwd: string;
  hostPid?: number | null;
  env?: Env;
}): Promise<SessionState> {
  validSid(sid);
  mkdirp(sessionsDir(env));
  let st = readState(sid, env);
  if (!st) {
    const host = shortHost();
    const label = fitLabel(
      cfg.user,
      host,
      defaultLabel(cwd, sid),
      transport.limits.maxLabelLen(cfg.user, host),
    );
    const created: SessionState = {
      address: `${cfg.user}.${host}.${label}`,
      aliases: [],
      cwd,
      createdAt: new Date().toISOString(),
    };
    if (createExclusive(statePath(sid, env), created)) {
      createExclusive(cursorPath(sid, env), { cursor: await transport.now(), seen: {} });
    }
    st = readState(sid, env);
    if (!st) throw new Error(`could not create session state at ${statePath(sid, env)}`);
  }
  if (!readCursor(sid, env)) {
    createExclusive(cursorPath(sid, env), { cursor: await transport.now(), seen: {} });
  }
  if (hostPid) {
    try {
      mkdirp(byPidDir(env));
      fs.writeFileSync(path.join(byPidDir(env), String(hostPid)), sid + '\n', { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
  return st;
}

export function updateState(
  sid: string,
  fn: (st: SessionState) => SessionState | void,
  env: Env = process.env,
): SessionState {
  const st = readState(sid, env);
  if (!st) throw new Error(`no state for session ${sid}`);
  const next = fn({ ...st, aliases: [...st.aliases] }) || st;
  atomicWriteJson(statePath(sid, env), next);
  return next;
}

export function allNames(st: SessionState): string[] {
  return [st.address, ...st.aliases];
}

// ---------- single-watcher lock ----------

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const LOCK_FRESH_MS = 60000;

/** A held pidfile lock. */
export interface HeldLock {
  ok: true;
  /** Mark the lock as alive; the holder must do this regularly. */
  touch(): void;
  release(): void;
}

/** Somebody else holds the lock. */
export interface BusyLock {
  ok: false;
  pid: number;
}

export type LockResult = HeldLock | BusyLock;

export function acquireLock(sid: string, env: Env = process.env): LockResult {
  mkdirp(sessionsDir(env));
  return acquireFileLock(lockPath(sid, env));
}

/**
 * A pidfile lock at `file` (its directory must exist): {ok:true, release, touch} or {ok:false, pid}.
 * The holder must touch() it at least every LOCK_FRESH_MS, or it counts as abandoned.
 */
export function acquireFileLock(file: string): LockResult {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n');
      fs.closeSync(fd);
      return {
        ok: true,
        touch() {
          try {
            const now = new Date();
            fs.utimesSync(file, now, now);
          } catch {
            /* ignore */
          }
        },
        release() {
          try {
            const cur = readJson(file);
            if (cur && cur.pid === process.pid) fs.rmSync(file, { force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Held? A lock is live only if the pid is alive AND the file was touched recently
    // (guards against pid reuse after a crash).
    let pid: unknown = null;
    let fresh = false;
    try {
      pid = readJson(file)?.pid ?? null;
      fresh = Date.now() - fs.statSync(file).mtimeMs < LOCK_FRESH_MS;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    if (typeof pid === 'number' && pid && pid !== process.pid && pidAlive(pid) && fresh)
      return { ok: false, pid };
    fs.rmSync(file, { force: true });
  }
  const last = readJson(file)?.pid;
  return { ok: false, pid: typeof last === 'number' ? last : 0 };
}

/**
 * The pid holding a lock file, if that holder is live: another process, alive, and the file was
 * touched within LOCK_FRESH_MS (guards against pid reuse after a crash). Otherwise null.
 */
function liveHolder(file: string): number | null {
  try {
    const pid = readJson(file)?.pid;
    const fresh = Date.now() - fs.statSync(file).mtimeMs < LOCK_FRESH_MS;
    return typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid !== process.pid &&
      fresh &&
      pidAlive(pid)
      ? pid
      : null;
  } catch {
    return null;
  }
}

/** pid of the live holder of a pidfile lock (other than this process), else null. */
export const lockHolder = (file: string): number | null => liveHolder(file);

/** pid of a live `watch` for the session (other than this process), else null. */
export const watcherPid = (sid: string, env: Env = process.env): number | null =>
  liveHolder(lockPath(sid, env));

/** pid of a live `wait` for the session (other than this process), else null. */
export const waiterPid = (sid: string, env: Env = process.env): number | null =>
  liveHolder(waitLockPath(sid, env));

/** Resolves once `pid` has exited, or after `timeoutMs`. */
export async function awaitExit(pid: number | null, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (pid && pidAlive(pid) && Date.now() - t0 < timeoutMs)
    await new Promise((r) => setTimeout(r, 50));
  return !pidAlive(pid);
}

/** A claim on the session's waiter lock. */
export interface WaitClaim {
  /** The live waiter this claim supersedes, if any. */
  prevPid: number | null;
  /** Is this claim still the newest? */
  mine(): boolean;
  touch(): void;
  release(): void;
}

/**
 * Claim the session's waiter lock. Unlike the watch lock this never fails: the newest claim wins
 * and the previous holder notices (mine() turns false) and steps aside. Returns
 * {prevPid, mine(), touch(), release()}; prevPid is the live waiter this claim supersedes.
 */
export function claimWaitLock(sid: string, env: Env = process.env): WaitClaim {
  const file = waitLockPath(sid, env);
  mkdirp(sessionsDir(env));
  const prevPid = waiterPid(sid, env);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  atomicWriteJson(file, { pid: process.pid, token, startedAt: Date.now() });
  const mine = () => readJson(file)?.token === token;
  return {
    prevPid,
    mine,
    touch() {
      if (!mine()) return;
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {
        /* ignore */
      }
    },
    release() {
      try {
        if (mine()) fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Ask the session's waiter to step aside (it notices within its lock poll). Returns its pid or null. */
export function stopWaiter(sid: string, env: Env = process.env): number | null {
  const pid = waiterPid(sid, env);
  fs.rmSync(waitLockPath(sid, env), { force: true });
  return pid;
}
