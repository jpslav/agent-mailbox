// The version of this build, and semantic-version comparison.
//
// scripts/build.mjs injects the package version as __MBOX_VERSION__ (esbuild `define`), so the
// committed bundle knows which release it is. Run from source (tsx), nothing is injected and the
// version is '0.0.0-dev'. The delivery daemon records its version in its lock file, and a newer
// session-start hook takes delivery over from an older daemon (deliverd.ts, registrations.ts).
import type { Env } from './types.js';

declare const __MBOX_VERSION__: string | undefined;

export const BUILD_VERSION: string =
  typeof __MBOX_VERSION__ === 'string' ? __MBOX_VERSION__ : '0.0.0-dev';

/**
 * The version this process runs as. AGENT_MAILBOX_FAKE_VERSION is a test-only knob: it lets the
 * test suite run "older" and "newer" daemons from one bundle. Never set it in normal use.
 */
export function ownVersion(env: Env = process.env): string {
  return env.AGENT_MAILBOX_FAKE_VERSION || BUILD_VERSION;
}

interface Semver {
  core: [number, number, number];
  pre: string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: unknown): Semver | null {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Is `v` a semantic version (MAJOR.MINOR.PATCH, optional -prerelease and +build)? */
export const isVersion = (v: unknown): boolean => parse(v) !== null;

const isNum = (s: string): boolean => /^\d+$/.test(s);

function comparePre(a: string[], b: string[]): number {
  // A release sorts above its prereleases: 1.0.0-rc.1 < 1.0.0.
  if (!a.length || !b.length) return (a.length ? -1 : 0) + (b.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNum(x) && isNum(y)) return Number(x) < Number(y) ? -1 : 1;
    if (isNum(x)) return -1; // numeric identifiers sort below alphanumeric ones
    if (isNum(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Semantic-version order: negative when a < b, 0 when equal, positive when a > b. Parts compare as
 * numbers (0.10.0 > 0.9.9). Anything that is not a version (missing, as in the lock file of a
 * daemon from before 0.5.3, or garbled) sorts below every version, so it is always replaced and
 * never replaces a versioned daemon.
 */
export function compareVersions(a: unknown, b: unknown): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!; // indices 0..2 of a 3-tuple
    if (d) return d < 0 ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}
