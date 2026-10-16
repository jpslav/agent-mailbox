// Per-session state under ${AGENT_MAILBOX_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-mailbox}/sessions/
//   <sid>.json         identity: {address, aliases[], cwd, createdAt}
//   <sid>.cursor.json  watcher-owned: {cursor (opaque, from the transport), seen (recently printed
//                      message ids)}   (kept apart so `mbox name` and the watcher never clobber
//                      each other's writes)
//   <sid>.lock         single-watcher pidfile
import fs from 'node:fs';
import path from 'node:path';
import { defaultLabel, fitLabel, shortHost } from './addr.js';
import { xdgDir } from './config.js';

export class NoSessionError extends Error {
  constructor() {
    super(
      'cannot determine the agent session id: pass --session <id>, set AGENT_MAILBOX_SESSION, ' +
        'or run inside an agent with an adapter (e.g. Claude Code, which provides CLAUDE_CODE_SESSION_ID).',
    );
  }
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function stateDir(env = process.env) {
  return env.AGENT_MAILBOX_STATE_DIR || path.join(xdgDir('XDG_STATE_HOME', path.join('.local', 'state'), env), 'agent-mailbox');
}
const sessionsDir = (env) => path.join(stateDir(env), 'sessions');
const byPidDir = (env) => path.join(stateDir(env), 'by-pid');

export const statePath = (sid, env = process.env) => path.join(sessionsDir(env), `${sid}.json`);
export const cursorPath = (sid, env = process.env) => path.join(sessionsDir(env), `${sid}.cursor.json`);
export const lockPath = (sid, env = process.env) => path.join(sessionsDir(env), `${sid}.lock`);

function validSid(sid) {
  if (!SID_RE.test(sid)) throw new Error(`invalid session id "${sid}" (allowed: letters, digits, . _ -)`);
  return sid;
}

export function validateSessionId(sid) {
  return validSid(String(sid));
}

/** Fallback lookup: session id recorded for a host (agent) process id by an earlier command. */
export function sessionIdForHostPid(pid, env = process.env) {
  if (!pid || !/^\d+$/.test(String(pid))) return null;
  try {
    const sid = fs.readFileSync(path.join(byPidDir(env), String(pid)), 'utf8').trim();
    return sid ? validSid(sid) : null;
  } catch {
    return null;
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Create-if-absent without ever exposing a half-written file. */
function createExclusive(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.new`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
}

export function readState(sid, env = process.env) {
  const s = readJson(statePath(sid, env));
  if (!s || typeof s.address !== 'string') return null;
  return { ...s, aliases: Array.isArray(s.aliases) ? s.aliases.filter((a) => typeof a === 'string') : [] };
}

export function readCursor(sid, env = process.env) {
  const c = readJson(cursorPath(sid, env));
  if (!c || c.cursor === undefined || c.cursor === null) return null;
  return { cursor: c.cursor, seen: c.seen && typeof c.seen === 'object' ? c.seen : {} };
}

export function writeCursor(sid, cur, env = process.env) {
  atomicWriteJson(cursorPath(sid, env), cur);
}

/**
 * Ensure identity + cursor exist for the session. A new session starts "now" (the transport's
 * notion of the current position) so old mail is not replayed; a resumed session (same id) keeps
 * its address and cursor.
 */
export async function ensureSession({ sid, cfg, transport, cwd, hostPid = null, env = process.env }) {
  validSid(sid);
  mkdirp(sessionsDir(env));
  let st = readState(sid, env);
  if (!st) {
    const host = shortHost();
    const label = fitLabel(cfg.user, host, defaultLabel(cwd, sid), transport.limits.maxLabelLen(cfg.user, host));
    const created = {
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

export function updateState(sid, fn, env = process.env) {
  const st = readState(sid, env);
  if (!st) throw new Error(`no state for session ${sid}`);
  const next = fn({ ...st, aliases: [...st.aliases] }) || st;
  atomicWriteJson(statePath(sid, env), next);
  return next;
}

export function allNames(st) {
  return [st.address, ...st.aliases];
}

// ---------- single-watcher lock ----------

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const LOCK_FRESH_MS = 60000;

/** Returns {ok:true, release, touch} or {ok:false, pid}. */
export function acquireLock(sid, env = process.env) {
  const file = lockPath(sid, env);
  mkdirp(sessionsDir(env));
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
      if (e.code !== 'EEXIST') throw e;
    }
    // Held? A lock is live only if the pid is alive AND the file was touched recently
    // (guards against pid reuse after a crash).
    let pid = null;
    let fresh = false;
    try {
      pid = readJson(file)?.pid ?? null;
      fresh = Date.now() - fs.statSync(file).mtimeMs < LOCK_FRESH_MS;
    } catch (e) {
      if (e.code === 'ENOENT') continue;
    }
    if (pid && pid !== process.pid && pidAlive(pid) && fresh) return { ok: false, pid };
    fs.rmSync(file, { force: true });
  }
  return { ok: false, pid: readJson(file)?.pid ?? 0 };
}
