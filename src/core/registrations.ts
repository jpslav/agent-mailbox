// Sessions registered for push delivery by `mbox deliverd`, one file per session, and the daemon's
// singleton lock. Agent-neutral: an agent adapter's session-start hook writes the registration
// (with the endpoint its `delivery.endpointFromHook` found), its session-end hook removes it.
//
//   <state>/registrations/<sid>.json   {sid, address, endpoint, hostPid, cwd, agent, registeredAt}
//                                      mode 0600 (the endpoint may hold a secret, e.g. a token)
//   <state>/deliverd.lock              the running daemon (pidfile lock)
//   <state>/deliverd.log               its concise, rotating log (never endpoints or tokens)
//   <state>/deliverd.out               its stdout/stderr (crash traces only)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWriteJson,
  lockHolder,
  mkdirp,
  readJson,
  stateDir,
  validateSessionId,
} from './state.js';
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

/**
 * Start the delivery daemon unless one is running: detached (own process group), stdio to a file,
 * not waited for. `argv` = [executable, ...args] that runs `mbox deliverd`; `dropEnv` = variables
 * the daemon must not inherit. The daemon's own lock
 * makes a race between two starters harmless (the second exits at once). Returns the new pid, or
 * null when one was already running.
 */
export function ensureDeliverd(
  argv: string[],
  env: Env = process.env,
  { dropEnv = [] }: { dropEnv?: string[] } = {},
): number | null {
  const running = deliverdPid(env);
  if (running) return null;
  const [command, ...args] = argv;
  if (!command) throw new TypeError('ensureDeliverd: argv must start with the executable');
  privateDir(stateDir(env));
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
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(fd);
  }
}
