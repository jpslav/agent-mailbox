// Emergency stop for push delivery on this machine: `mbox pause [--all|<address>]`, `mbox resume`.
// While a session is paused, `mbox deliverd` holds its mail (unacknowledged, still on the server)
// and delivers it after `mbox resume`. State: <state>/paused.json {all: bool, addresses: [..]}.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, mkdirp, readJson, stateDir } from './state.js';
import type { Env } from './types.js';

/** `<state>/paused.json`: which sessions on this machine are held. */
export interface PauseState {
  all: boolean;
  addresses: string[];
}

/** What `readJson` makes of paused.json: hand-editable, so every field is checked. */
interface PauseFile {
  all?: unknown;
  addresses?: unknown;
}

export const pausePath = (env: Env = process.env): string =>
  path.join(stateDir(env), 'paused.json');

/** -> {all, addresses[]} */
export function readPause(env: Env = process.env): PauseState {
  const j = readJson(pausePath(env)) as PauseFile | null;
  return {
    all: j?.all === true,
    addresses: Array.isArray(j?.addresses)
      ? (j.addresses as unknown[]).filter((a): a is string => typeof a === 'string')
      : [],
  };
}

function writePause(p: PauseState, env: Env): void {
  mkdirp(stateDir(env));
  if (!p.all && !p.addresses.length) {
    fs.rmSync(pausePath(env), { force: true });
    return;
  }
  atomicWriteJson(pausePath(env), {
    all: p.all,
    addresses: [...new Set(p.addresses)].sort(),
    at: new Date().toISOString(),
  });
}

/** Pause one address, or everything with `all`. */
export function pause(
  { all = false, address = null }: { all?: boolean; address?: string | null },
  env: Env = process.env,
): PauseState {
  const p = readPause(env);
  if (all) p.all = true;
  else if (address && !p.addresses.includes(address)) p.addresses.push(address);
  writePause(p, env);
  return p;
}

/** Resume one address, or everything (all and every single address) with `all`. */
export function resume(
  { all = false, address = null }: { all?: boolean; address?: string | null },
  env: Env = process.env,
): PauseState {
  const p = readPause(env);
  if (all) {
    p.all = false;
    p.addresses = [];
  } else if (address) p.addresses = p.addresses.filter((a) => a !== address);
  writePause(p, env);
  return p;
}

/** Is delivery to a session with these names (address + aliases) paused? */
export const isPaused = (p: PauseState, names: string[]): boolean =>
  p.all || names.some((n) => p.addresses.includes(n));
