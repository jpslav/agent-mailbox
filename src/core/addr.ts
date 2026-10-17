// Agent-neutral, broker-neutral addresses: <user>.<host>.<label>, each segment [a-z0-9-]+.
// (How an address maps onto the broker -- topics, subjects -- is the transport's business.)
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BROADCAST = 'all';
export const SEG_RE = /^[a-z0-9-]+$/;
export const USER_RE = /^[a-z0-9-]+$/;

export function sanitizeSeg(s: string, max = 64): string {
  let out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  out = out.slice(0, max).replace(/-+$/, '');
  return out;
}

export function shortHost(): string {
  const h = os.hostname().split('.')[0] ?? '';
  return sanitizeSeg(h, 24) || 'host';
}

/** Sanitise `label` and truncate it to `maxLen` (the transport says how long a label may be). */
export function fitLabel(user: string, host: string, label: string, maxLen: number): string {
  if (maxLen < 1) throw new Error(`user "${user}" and host "${host}" are too long to form an address on this broker`);
  const out = sanitizeSeg(label, maxLen);
  if (!out) throw new Error(`label "${label}" has no usable characters (allowed: a-z 0-9 -)`);
  return out;
}

export function gitToplevel(cwd: string): string | null {
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

export function defaultLabel(cwd: string, sessionId: string): string {
  const base = path.basename(gitToplevel(cwd) || cwd) || 'session';
  const name = sanitizeSeg(base, 20) || 'session';
  const sid = sanitizeSeg(String(sessionId).slice(0, 4), 4) || 'x';
  return `${name}-${sid}`;
}

export interface ParsedAddr {
  user: string;
  host: string;
  label: string;
}

export function parseAddr(s: unknown): ParsedAddr | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEG_RE.test(p))) return null;
  const [user, host, label] = parts as [string, string, string];
  return { user, host, label };
}

export const isAddr = (s: unknown): boolean => parseAddr(s) !== null;
