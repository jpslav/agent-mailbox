// Presence records and peer resolution. Storing/expiring presence is the transport's job
// (transport.presence); this file only builds the record and resolves "who did the user mean".
import { isAddr, parseAddr } from './addr.js';
import { checkOffers } from './areas.js';
import { isService } from './services.js';
import { gitInfo, type GitInfo } from './session-meta.js';
import type { Config, PresenceEntry, PresenceRecord, SessionState } from './types.js';

export const HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * The presence record for a session: what peers see in `mbox peers`. The repo and branch are
 * read from the session's working directory each time (`git` overrides that, for tests).
 */
export function presenceRecord(
  st: SessionState,
  {
    sid,
    cfg,
    agent = 'unknown',
    pid = process.pid,
    git,
  }: { sid: string; cfg: Pick<Config, 'user'>; agent?: string; pid?: number; git?: GitInfo },
): PresenceRecord {
  const { repo, branch } = git ?? gitInfo(st.cwd);
  return {
    address: st.address,
    aliases: st.aliases,
    session: sid,
    agent,
    user: cfg.user,
    host: parseAddr(st.address)?.host ?? null,
    cwd: st.cwd,
    pid,
    repo,
    branch,
    role: st.role ?? null,
    parent: st.parent ?? null,
    status: st.status ?? null,
    offers: checkOffers(st.offers),
  };
}

export class ResolveError extends Error {}

/** Who `resolveTarget` decided the user meant. */
export interface ResolvedTarget {
  to: string;
  live: boolean;
  peer: PresenceEntry | null;
}

/**
 * Resolve a user-supplied target against `peers` (transport.presence.list()).
 * Returns {to, live, peer}; `to` is 'all' for broadcast. A service address (`<user>.<name>`) is
 * always itself, never a prefix of session addresses; whether a live session holds it is in the
 * claims, not in `peers`, so `live` is false and the caller asks the claims.
 */
export function resolveTarget(input: unknown, peers: PresenceEntry[]): ResolvedTarget {
  const raw = String(input).trim();
  if (!raw) throw new ResolveError('missing recipient');
  if (raw === 'all') return { to: 'all', live: true, peer: null };
  if (isService(raw)) return { to: raw, live: false, peer: null };
  const live = peers.filter((p) => p.live);
  const nameOwners = new Map<string, PresenceEntry>(); // name -> peer
  for (const p of live)
    for (const n of [p.address, ...p.aliases]) if (!nameOwners.has(n)) nameOwners.set(n, p);

  if (isAddr(raw)) {
    const peer = nameOwners.get(raw) || null;
    return { to: raw, live: !!peer, peer };
  }
  // Every name here is a valid address (the transport only lists those), so `labelOf` never gets ''.
  const labelOf = (n: string): string => parseAddr(n)?.label ?? '';
  const tiers: Array<(n: string) => boolean> = [
    (n) => n === raw,
    (n) => labelOf(n) === raw,
    (n) => n.endsWith('.' + raw),
    (n) => n.startsWith(raw),
    (n) => labelOf(n).startsWith(raw),
  ];
  for (const match of tiers) {
    const hits = [...nameOwners.entries()].filter(([n]) => match(n));
    const first = hits[0];
    if (!first) continue;
    const sessions = new Set(hits.map(([, p]) => p.session));
    if (sessions.size > 1) {
      const lines = hits.map(
        ([n, p]) => `  ${n}${n !== p.address ? ` (alias of ${p.address})` : ''}`,
      );
      throw new ResolveError(
        `"${raw}" is ambiguous; matches ${sessions.size} live sessions:\n${lines.join('\n')}\nUse a longer prefix or the full address.`,
      );
    }
    const peer = first[1];
    // Several names for one session: prefer an exact alias hit, else the primary address.
    const exact = hits.find(([n]) => n === raw);
    const name = exact ? exact[0] : (hits.find(([n]) => n === peer.address)?.[0] ?? first[0]);
    return { to: name, live: true, peer };
  }
  throw new ResolveError(
    `no live peer matches "${raw}". Run \`mbox peers\` to see live sessions, or use a full address (<user>.<host>.<label>) to queue a message anyway.`,
  );
}

/** One line of `mbox peers --tree`: a peer, how deep it sits, and why it is a root if it is one. */
export interface TreeRow {
  peer: PresenceEntry;
  /** Drawn before the address: "", "├─ ", "│  └─ ", ... */
  prefix: string;
  /** Set on a root whose `parent` is not a live peer ('parent not live') or is in a cycle. */
  note: 'parent not live' | 'parent cycle' | null;
}

/**
 * Lay out live peers as a forest by their self-asserted `parent` (an address or alias of another
 * live peer). Display only: a parent claim proves nothing. A peer whose parent is not live is a
 * root, marked; a cycle is cut at its first member (by address), also marked. Roots and siblings
 * keep the order of `peers`.
 */
export function peerTree(peers: PresenceEntry[]): TreeRow[] {
  const live = peers.filter((p) => p.live);
  const owner = new Map<string, PresenceEntry>();
  for (const p of live)
    for (const n of [p.address, ...p.aliases]) if (!owner.has(n)) owner.set(n, p);
  const parentOf = (p: PresenceEntry): PresenceEntry | null => {
    const q = p.parent ? owner.get(p.parent) : undefined;
    return q && q !== p ? q : null;
  };
  const children = new Map<PresenceEntry, PresenceEntry[]>();
  for (const p of live) {
    const q = parentOf(p);
    if (q) children.set(q, [...(children.get(q) ?? []), p]);
  }
  const rows: TreeRow[] = [];
  const placed = new Set<PresenceEntry>();
  const walk = (p: PresenceEntry, lead: string, branch: string, note: TreeRow['note']): void => {
    placed.add(p);
    rows.push({ peer: p, prefix: lead + branch, note });
    const kids = (children.get(p) ?? []).filter((k) => !placed.has(k));
    const next = lead + (branch === '' ? '' : branch === '└─ ' ? '   ' : '│  ');
    kids.forEach((k, i) => walk(k, next, i === kids.length - 1 ? '└─ ' : '├─ ', null));
  };
  for (const p of live) {
    if (parentOf(p) || placed.has(p)) continue;
    // No live parent: none claimed, a parent that is not live, or itself (a one-session cycle).
    const note = !p.parent ? null : owner.get(p.parent) === p ? 'parent cycle' : 'parent not live';
    walk(p, '', '', note);
  }
  // Everything left is in a cycle or hangs off one: cut each cycle at its first member by address.
  for (let p = live.find((x) => !placed.has(x)); p; p = live.find((x) => !placed.has(x))) {
    const path: PresenceEntry[] = [];
    let q: PresenceEntry | null = p;
    while (q && !path.includes(q)) {
      path.push(q);
      q = parentOf(q);
    }
    // `q` is where the walk came back to: the cycle is path[from q on].
    const cycle = q ? path.slice(path.indexOf(q)) : path;
    const first = cycle.reduce((a, b) => (b.address < a.address ? b : a));
    walk(first, '', '', 'parent cycle');
  }
  return rows;
}
