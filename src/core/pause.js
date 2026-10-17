// Emergency stop for push delivery on this machine: `mbox pause [--all|<address>]`, `mbox resume`.
// While a session is paused, `mbox deliverd` holds its mail (unacknowledged, still on the server)
// and delivers it after `mbox resume`. State: <state>/paused.json {all: bool, addresses: [..]}.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, mkdirp, readJson, stateDir } from './state.js';

export const pausePath = (env = process.env) => path.join(stateDir(env), 'paused.json');

/** -> {all, addresses[]} */
export function readPause(env = process.env) {
  const j = readJson(pausePath(env));
  return {
    all: j?.all === true,
    addresses: Array.isArray(j?.addresses) ? j.addresses.filter((a) => typeof a === 'string') : [],
  };
}

function writePause(p, env) {
  mkdirp(stateDir(env));
  if (!p.all && !p.addresses.length) {
    fs.rmSync(pausePath(env), { force: true });
    return;
  }
  atomicWriteJson(pausePath(env), { all: p.all, addresses: [...new Set(p.addresses)].sort(), at: new Date().toISOString() });
}

/** Pause one address, or everything with `all`. */
export function pause({ all = false, address = null }, env = process.env) {
  const p = readPause(env);
  if (all) p.all = true;
  else if (address && !p.addresses.includes(address)) p.addresses.push(address);
  writePause(p, env);
  return p;
}

/** Resume one address, or everything (all and every single address) with `all`. */
export function resume({ all = false, address = null }, env = process.env) {
  const p = readPause(env);
  if (all) {
    p.all = false;
    p.addresses = [];
  } else if (address) p.addresses = p.addresses.filter((a) => a !== address);
  writePause(p, env);
  return p;
}

/** Is delivery to a session with these names (address + aliases) paused? */
export const isPaused = (p, names) => p.all || names.some((n) => p.addresses.includes(n));
