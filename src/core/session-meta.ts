// Session metadata shown in presence: what a session says about itself (role, parent, status)
// and what it is working on (repo and branch of its working directory). All of it is display
// only. Role and parent are self-asserted and never grant authority; peers check every field for
// shape (`checkRole`, `checkParent`, `checkStatus`, ...) because any user can write anything into
// their own presence entries.
import fs from 'node:fs';
import path from 'node:path';
import { isAddr } from './addr.js';
import { oneLine } from './envelope.js';
import type { Role } from './types.js';

export const ROLES: readonly Role[] = ['manager', 'worker'];
/** The longest status line `mbox status` accepts; longer ones from peers are cut to this. */
export const STATUS_MAX = 120;
const BRANCH_MAX = 100;
const REPO_MAX = 100;

export const checkRole = (v: unknown): Role | null => ROLES.find((r) => r === v) ?? null;

export const checkParent = (v: unknown): string | null =>
  typeof v === 'string' && isAddr(v) ? v : null;

/** A status as one line: control characters become spaces; '' means none. */
export function statusLine(v: unknown): string {
  return oneLine(v, Infinity).replace(/\s+/g, ' ');
}

/** A peer's status: one line of at most STATUS_MAX characters, or null. */
export function checkStatus(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = statusLine(v);
  if (!t) return null;
  return t.length > STATUS_MAX ? t.slice(0, STATUS_MAX - 1) + '…' : t;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const checkRepo = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= REPO_MAX && REPO_RE.test(v) ? v : null;

// A branch name as git allows it, minus anything that could disturb a terminal or a table.
const BRANCH_RE = /^[A-Za-z0-9._/+@#%=,~-]+$/;
export const checkBranch = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= BRANCH_MAX && BRANCH_RE.test(v) ? v : null;

// ---------------------------------------------------------------- git

export interface GitInfo {
  repo: string | null;
  branch: string | null;
}

const NO_GIT: GitInfo = { repo: null, branch: null };
const MAX_READ = 1024 * 1024;

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The git directory and the common directory (they differ in a linked worktree) for `cwd`. */
function findGitDirs(cwd: string): { gitDir: string; commonDir: string } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      /* not here */
    }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        // A linked worktree or a submodule: ".git" is a file "gitdir: <path>".
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dotGit) ?? '');
        if (!m?.[1]) return null;
        gitDir = path.resolve(dir, m[1]);
      }
      const common = readSmall(path.join(gitDir, 'commondir'))?.trim();
      return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The URL of remote `origin`, else of the first remote that has one, from a git config file. */
export function remoteUrl(config: string): string | null {
  let section: string | null = null;
  const urls: Array<[string, string]> = [];
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*remote\s+"([^"]*)"\s*\]/i.exec(line);
    if (sec) {
      section = sec[1] ?? '';
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    const kv = /^url\s*=\s*(.*)$/i.exec(line);
    if (section !== null && kv?.[1]) urls.push([section, kv[1].replace(/^"(.*)"$/, '$1').trim()]);
  }
  return (urls.find(([s]) => s === 'origin') ?? urls[0])?.[1] ?? null;
}

/**
 * `owner/name` from a remote URL: the last two path segments, without ".git". Handles
 * `https://host/owner/name.git`, `ssh://git@host:22/owner/name` and `git@host:owner/name.git`.
 * Credentials in the URL are never part of the result. A local path gives null.
 */
export function repoFromUrl(url: string): string | null {
  let p: string;
  const scp = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?!\/\/)(.+)$/.exec(url); // [git@]host:owner/name
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    if (/^file:/i.test(url)) return null;
    try {
      p = new URL(url).pathname;
    } catch {
      return null;
    }
  } else if (scp?.[1]) p = scp[1];
  else return null;
  const parts = p
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  return checkRepo(parts.slice(-2).join('/'));
}

/**
 * The repository and branch of the git checkout that holds `cwd`, read from git's own files: no
 * `git` process runs, so nothing configured in the repository (hooks, fsmonitor) is ever executed,
 * and the delivery daemon can refresh it for every session on each heartbeat at no cost.
 */
export function gitInfo(cwd: string | null | undefined): GitInfo {
  if (!cwd) return NO_GIT;
  const dirs = findGitDirs(cwd);
  if (!dirs) return NO_GIT;
  const head = readSmall(path.join(dirs.gitDir, 'HEAD'))?.trim() ?? '';
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  const config = readSmall(path.join(dirs.commonDir, 'config'));
  const url = config ? remoteUrl(config) : null;
  return { repo: url ? repoFromUrl(url) : null, branch: checkBranch(ref) };
}
