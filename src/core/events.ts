// The events feed: what happens to a user's sessions (started, ended, status, role and parent
// changes, done), for the user and, where the admin shares the feed with the team, for colleagues
// and their overseer sessions. An event carries a session's metadata (the presence fields), never
// message contents. Feeds are read on demand (`mbox events`); nobody is woken per event.
//
// Writing an event is best effort: a session start, a status change or a session end must never
// fail, or wait long, because the feed could not be written.
import { parseAddr } from './addr.js';
import {
  checkBranch,
  checkParent,
  checkRepo,
  checkRole,
  checkStatus,
  gitInfo,
  type GitInfo,
} from './session-meta.js';
import { claimEnded, clearEnded } from './state.js';
import type {
  Config,
  Env,
  EventKind,
  FeedEntry,
  SessionEvent,
  SessionState,
  Transport,
} from './types.js';

export const EVENT_KINDS: readonly EventKind[] = [
  'started',
  'ended',
  'status-changed',
  'role-changed',
  'parent-changed',
  'done',
];

/** How long an event write may hold up the command or hook that triggers it. */
export const EVENT_TIMEOUT_MS = 1500;

/** The event for a session's current state (repo and branch read from its working directory). */
export function sessionEvent(
  event: EventKind,
  st: SessionState,
  { cfg, git, at = new Date() }: { cfg: Pick<Config, 'user'>; git?: GitInfo; at?: Date },
): SessionEvent {
  const { repo, branch } = git ?? gitInfo(st.cwd);
  return {
    event,
    address: st.address,
    user: cfg.user,
    host: parseAddr(st.address)?.host ?? null,
    repo,
    branch,
    role: st.role ?? null,
    parent: st.parent ?? null,
    status: st.status ?? null,
    at: at.toISOString(),
  };
}

/**
 * Write `event` for the session to the own feed. Never throws: resolves to null when it was
 * written, else to the error, so a caller may warn.
 */
export async function emitEvent(
  transport: Pick<Transport, 'events'>,
  event: EventKind,
  st: SessionState,
  opts: { cfg: Pick<Config, 'user'>; git?: GitInfo; timeoutMs?: number },
): Promise<unknown> {
  try {
    const ev = sessionEvent(event, st, opts);
    const timeoutMs = opts.timeoutMs ?? EVENT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      transport.events.publish(ev, { timeoutMs }),
      new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
          timeoutMs,
        ); // not unref'd: the bound must hold even when nothing else keeps the process alive
      }),
    ]).finally(() => clearTimeout(timer));
    return null;
  } catch (e) {
    return e ?? new Error('event not written');
  }
}

/** What `emitStarted` and `emitEnded` need besides the transport and the state. */
export interface LifecycleOptions {
  cfg: Pick<Config, 'user'>;
  sid: string;
  env?: Env;
  git?: GitInfo;
  timeoutMs?: number;
}

/** `started`: the session is live (again), so its next end writes `ended` again. */
export function emitStarted(
  transport: Pick<Transport, 'events'>,
  st: SessionState,
  { sid, env = process.env, ...opts }: LifecycleOptions,
): Promise<unknown> {
  try {
    clearEnded(sid, env);
  } catch {
    /* the next end may then be skipped; never fail a session start over it */
  }
  return emitEvent(transport, 'started', st, opts);
}

/**
 * `ended`, at most once per start, by whoever notices first: the session-end hook, or the
 * delivery daemon finding the session's process gone (no hook ran: a crash, a closed terminal).
 * Resolves to null when it was written or already had been, else to the error.
 */
export async function emitEnded(
  transport: Pick<Transport, 'events'>,
  st: SessionState,
  { sid, env = process.env, ...opts }: LifecycleOptions,
): Promise<unknown> {
  let first: boolean;
  try {
    first = claimEnded(sid, env);
  } catch (e) {
    return e ?? new Error('ended not claimed');
  }
  return first ? emitEvent(transport, 'ended', st, opts) : null;
}

/** An event as stored: written by the feed's owner, so nothing in it is trusted. */
interface UntrustedEvent {
  event?: unknown;
  address?: unknown;
  repo?: unknown;
  branch?: unknown;
  role?: unknown;
  parent?: unknown;
  status?: unknown;
  at?: unknown;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * A stored event, checked: `user` is the feed's owner (verified by the server, which lets only
 * that user write the feed) and `time` the server's timestamp. An entry that is not an event of a
 * known kind, or names an address of another user, is dropped (null). The other fields are
 * self-asserted and kept only when they have the right shape, as in presence.
 */
export function checkEvent(payload: string, user: string, time: number): FeedEntry | null {
  let j: UntrustedEvent | null;
  try {
    j = JSON.parse(payload) as UntrustedEvent | null;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const event = EVENT_KINDS.find((k) => k === j.event);
  const addr = typeof j.address === 'string' ? parseAddr(j.address) : null;
  if (!event || !addr || addr.user !== user) return null;
  return {
    event,
    address: j.address as string, // parseAddr accepted it, so it is a string
    user,
    host: addr.host,
    repo: checkRepo(j.repo),
    branch: checkBranch(j.branch),
    role: checkRole(j.role),
    parent: checkParent(j.parent),
    status: checkStatus(j.status),
    at: typeof j.at === 'string' && ISO_RE.test(j.at) ? j.at : new Date(time).toISOString(),
    time,
  };
}
