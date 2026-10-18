// Per-session state under ${AGENT_MAILBOX_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-mailbox}/sessions/
// (for a named profile, under .../agent-mailbox/profiles/<name>/sessions/, see stateDir)
//   <sid>.json         identity: {address, aliases[], cwd, createdAt}
//   <sid>.cursor.json  watcher-owned: {cursor (opaque, from the transport), seen (recently printed
//                      message ids)}   (kept apart so `mbox name` and the watcher never clobber
//                      each other's writes)
//   <sid>.lock         single-receiver pidfile (`mbox watch`, or `mbox deliverd` serving the session)
//   <sid>.wait.lock    current hook waiter (`mbox wait`); the newest claim wins
//   <sid>.ended        the session's `ended` event was written (claimEnded); `started` removes it
import fs from 'node:fs';
import path from 'node:path';
import { defaultLabel, fitLabel, parseAddr, shortHost } from './addr.js';
import { checkOffers } from './areas.js';
import { checkServices } from './services.js';
import { profileName, xdgDir } from './config.js';
import { checkParent, checkRole, checkStatus } from './session-meta.js';
import type { Config, CursorFile, Env, Role, SessionState, Transport } from './types.js';

export class NoSessionError extends Error {
  constructor() {
    super(
      'cannot determine the agent session id: pass --session <id>, set AGENT_MAILBOX_SESSION, ' +
        'or run inside an agent with an adapter (e.g. Claude Code, which provides CLAUDE_CODE_SESSION_ID).',
    );
  }
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * AGENT_MAILBOX_STATE_DIR, else `agent-mailbox` under the XDG state home. A named profile gets
 * `profiles/<name>` below that, so each profile has its own sessions, registrations, pause file
 * and delivery daemon.
 */
export function stateDir(env: Env = process.env): string {
  const base =
    env.AGENT_MAILBOX_STATE_DIR ||
    path.join(xdgDir('XDG_STATE_HOME', path.join('.local', 'state'), env), 'agent-mailbox');
  const profile = profileName(env);
  return profile ? path.join(base, 'profiles', profile) : base;
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
/** Present once the session's `ended` event was claimed; `started` removes it (see events.ts). */
export const endedPath = (sid: string, env: Env = process.env): string =>
  path.join(sessionsDir(env), `${sid}.ended`);

/**
 * Claim writing the session's `ended` event: true for the first caller since the session last
 * started, false for every later one, in any process (the file is created exclusively).
 */
export function claimEnded(sid: string, env: Env = process.env): boolean {
  validSid(sid);
  try {
    mkdirp(sessionsDir(env));
    fs.writeFileSync(endedPath(sid, env), new Date().toISOString() + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (e) {
    // Only "already claimed" stops it; a state directory that cannot be written still gets its
    // event (one duplicate at worst, never a missing end).
    return (e as NodeJS.ErrnoException).code !== 'EEXIST';
  }
}

/** The session is live again: its next end writes `ended` again. */
export function clearEnded(sid: string, env: Env = process.env): void {
  validSid(sid);
  fs.rmSync(endedPath(sid, env), { force: true });
}

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
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.new`;
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
  // `address` is checked, and the metadata peers will see; the other fields were written by
  // ensureSession and are not re-validated.
  const { previousAddress, offers, services, ...rest } = s;
  return {
    ...rest,
    aliases,
    role: checkRole(s.role),
    parent: checkParent(s.parent),
    status: checkStatus(s.status),
    ...(offers !== undefined && { offers: checkOffers(offers) }),
    // Only the address's own user's services: a claim is made with that user's credentials.
    ...(services !== undefined && {
      services: checkServices(services, parseAddr(s.address)?.user ?? ''),
    }),
    ...(typeof previousAddress === 'string' && { previousAddress }),
  } as unknown as SessionState;
}

/** What a spawner passed in AGENT_MAILBOX_ROLE / AGENT_MAILBOX_PARENT (unset or invalid: absent). */
export function envMeta(env: Env = process.env): { role?: Role; parent?: string } {
  const role = checkRole(env.AGENT_MAILBOX_ROLE?.trim());
  const parent = checkParent(env.AGENT_MAILBOX_PARENT?.trim());
  return { ...(role && { role }), ...(parent && { parent }) };
}

export function readCursor(sid: string, env: Env = process.env): CursorFile | null {
  const c = readJson(cursorPath(sid, env));
  if (!c || c.cursor === undefined || c.cursor === null) return null;
  return {
    cursor: c.cursor,
    seen: c.seen && typeof c.seen === 'object' ? (c.seen as Record<string, number>) : {},
    ...(typeof c.address === 'string' && { address: c.address }),
  };
}

export function writeCursor(sid: string, cur: CursorFile, env: Env = process.env): void {
  atomicWriteJson(cursorPath(sid, env), cur);
}

/** The user an address belongs to, or null when it is not a valid address. */
export const addressUser = (address: unknown): string | null => parseAddr(address)?.user ?? null;

/**
 * Can a receiver for `st` start from cursor `c`? A cursor is a position in one user's mail, so one
 * made for another user's address is not, nor is one written without an address (before 0.5.7, or
 * by an older receiver) once the session has been given a new address under another user.
 */
export function cursorFits(c: CursorFile, st: SessionState): boolean {
  return c.address !== undefined
    ? addressUser(c.address) === addressUser(st.address)
    : !st.previousAddress;
}

/** The session's address belongs to another user than the one this mailbox is configured as. */
export class ForeignAddressError extends Error {
  constructor(address: string, user: string) {
    super(
      `this session's address ${address} belongs to user ${addressUser(address) ?? '?'}, but this mailbox is configured as user ${user}. ` +
        'Run any mbox command in the session (e.g. mbox whoami) to give it an address under the configured user, or restart the session.',
    );
  }
}

export interface EnsureSessionInput {
  sid: string;
  cfg: Pick<Config, 'user'>;
  transport: Pick<Transport, 'limits' | 'now'>;
  cwd: string;
  hostPid?: number | null;
  env?: Env;
  /**
   * The stored address belonged to another user, so the session got a new one: `from` -> `to`.
   * The caller says so (a log line, the session's instructions).
   */
  onReaddress?: (from: string, to: string) => void;
}

/**
 * Ensure identity + cursor exist for the session. A new session starts "now" (the transport's
 * notion of the current position) so old mail is not replayed; a resumed session (same id) keeps
 * its address and cursor. A new session takes its role and parent from the environment
 * (`envMeta`), as a spawner passes them; after that only `mbox whoami --role/--parent` changes
 * them, so a resume or a compaction (the same environment again) never undoes such a change.
 *
 * A stored address of another user than `cfg.user` (the machine's or profile's mailbox user was
 * changed with `mbox setup`) cannot be read with these credentials, so the session gets a new
 * address under `cfg.user` with the same label, a fresh cursor and no aliases (an alias must belong
 * to the same user), and `onReaddress` is told. Mail to the old address stays on the server.
 */
export async function ensureSession({
  sid,
  cfg,
  transport,
  cwd,
  hostPid = null,
  env = process.env,
  onReaddress = () => {},
}: EnsureSessionInput): Promise<SessionState> {
  validSid(sid);
  mkdirp(sessionsDir(env));
  let st = readState(sid, env);
  if (st && addressUser(st.address) !== cfg.user) {
    const from = st.address;
    const host = shortHost();
    const label = fitLabel(
      cfg.user,
      host,
      parseAddr(from)?.label || defaultLabel(cwd, sid),
      transport.limits.maxLabelLen(cfg.user, host),
    );
    const address = `${cfg.user}.${host}.${label}`;
    // Services go like aliases: they belong to the old user (their claims lapse on their own).
    const { parent, ...rest } = st;
    delete rest.services;
    const next: SessionState = {
      ...rest,
      address,
      aliases: [],
      previousAddress: from,
      ...(parent && parent !== address && { parent }),
    };
    // The state first, then the cursor: a receiver still running for the old address stops writing
    // its cursor once the state names another address (receiver.ts), and a crash in between leaves
    // an old cursor that cursorFits rejects.
    atomicWriteJson(statePath(sid, env), next);
    writeCursor(sid, { cursor: await transport.now(), seen: {}, address }, env);
    st = readState(sid, env);
    if (!st) throw new Error(`could not update session state at ${statePath(sid, env)}`);
    onReaddress(from, st.address);
  }
  if (!st) {
    const host = shortHost();
    const label = fitLabel(
      cfg.user,
      host,
      defaultLabel(cwd, sid),
      transport.limits.maxLabelLen(cfg.user, host),
    );
    const address = `${cfg.user}.${host}.${label}`;
    const { role, parent } = envMeta(env);
    const created: SessionState = {
      address,
      aliases: [],
      cwd,
      createdAt: new Date().toISOString(),
      ...(role && { role }),
      ...(parent && parent !== address && { parent }), // a session is not its own parent
    };
    if (createExclusive(statePath(sid, env), created)) {
      createExclusive(cursorPath(sid, env), { cursor: await transport.now(), seen: {}, address });
    }
    st = readState(sid, env);
    if (!st) throw new Error(`could not create session state at ${statePath(sid, env)}`);
  }
  const cur = readCursor(sid, env);
  if (!cur) {
    createExclusive(cursorPath(sid, env), {
      cursor: await transport.now(),
      seen: {},
      address: st.address,
    });
  } else if (!cursorFits(cur, st)) {
    writeCursor(sid, { cursor: await transport.now(), seen: {}, address: st.address }, env);
    // A new address whose fresh cursor was never written (the transport failed in between): the
    // change was not announced either, so announce it now.
    if (st.previousAddress && cur.address !== st.address)
      onReaddress(st.previousAddress, st.address);
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
 * Remove an abandoned lock file, but only the one that was judged abandoned (inode `ino`): if
 * another process replaced it with a fresh lock in the meantime, that one is put back.
 */
function removeAbandoned(file: string, ino: number): void {
  const aside = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // already gone
  }
  try {
    if (fs.statSync(aside).ino !== ino) fs.linkSync(aside, file); // not the abandoned one: restore it
  } catch {
    /* restored by someone else, or a newer lock is in place */
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/**
 * A pidfile lock at `file` (its directory must exist): {ok:true, release, touch} or {ok:false, pid}.
 * The file holds {pid, startedAt, ...info}. The holder must touch() it at least every
 * LOCK_FRESH_MS, or it counts as abandoned.
 */
export function acquireFileLock(file: string, info: Record<string, unknown> = {}): LockResult {
  const content = { ...info, pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    // Created complete or not at all: a reader must never see an empty lock and call it abandoned.
    if (createExclusive(file, content))
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
    // Held? A lock is live only if the pid is alive AND the file was touched recently
    // (guards against pid reuse after a crash).
    let pid: unknown = null;
    let fresh = false;
    let ino = 0;
    try {
      const st = fs.statSync(file);
      ino = st.ino;
      fresh = Date.now() - st.mtimeMs < LOCK_FRESH_MS;
      pid = readJson(file)?.pid ?? null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    if (typeof pid === 'number' && pid && pid !== process.pid && pidAlive(pid) && fresh)
      return { ok: false, pid };
    removeAbandoned(file, ino);
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

/**
 * What a live holder (other than this process) wrote into a pidfile lock: {pid, startedAt, ...info}
 * as untrusted JSON (the caller checks the fields it uses), else null.
 */
export function lockInfo(file: string): Record<string, unknown> | null {
  const pid = liveHolder(file);
  if (pid === null) return null;
  const info = readJson(file);
  return info && typeof info === 'object' && info.pid === pid ? info : null;
}

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
