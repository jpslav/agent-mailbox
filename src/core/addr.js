// Agent-neutral, broker-neutral addresses: <user>.<host>.<label>, each segment [a-z0-9-]+.
// (How an address maps onto the broker -- topics, subjects -- is the transport's business.)
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BROADCAST = 'all';
export const SEG_RE = /^[a-z0-9-]+$/;
export const USER_RE = /^[a-z0-9-]+$/;

export function sanitizeSeg(s, max = 64) {
  let out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  out = out.slice(0, max).replace(/-+$/, '');
  return out;
}

export function shortHost() {
  const h = os.hostname().split('.')[0];
  return sanitizeSeg(h, 24) || 'host';
}

/** Sanitise `label` and truncate it to `maxLen` (the transport says how long a label may be). */
export function fitLabel(user, host, label, maxLen) {
  if (maxLen < 1) throw new Error(`user "${user}" and host "${host}" are too long to form an address on this broker`);
  const out = sanitizeSeg(label, maxLen);
  if (!out) throw new Error(`label "${label}" has no usable characters (allowed: a-z 0-9 -)`);
  return out;
}

export function gitToplevel(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

export function defaultLabel(cwd, sessionId) {
  const base = path.basename(gitToplevel(cwd) || cwd) || 'session';
  const name = sanitizeSeg(base, 20) || 'session';
  const sid = sanitizeSeg(String(sessionId).slice(0, 4), 4) || 'x';
  return `${name}-${sid}`;
}

export function parseAddr(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEG_RE.test(p))) return null;
  return { user: parts[0], host: parts[1], label: parts[2] };
}

export const isAddr = (s) => parseAddr(s) !== null;
