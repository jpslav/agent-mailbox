// The mailbox panel's model: checking the snapshot JSON and the pure helpers the views use. No
// `$` here (a hooks module passes `$` only to functions declared in its own file), so the
// tests call these directly.
import type { Kind, Peer, Relation, Self, Snapshot } from '../types';

// ---------------------------------------------------------------- checking JSON

/** One printable line: control and format characters (escape sequences, bidi) become spaces. */
export function clean(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Loose = Record<string, unknown>;
// The boundary: parsed JSON from mbox or the daemon, checked field by field below.
const obj = (v: unknown): Loose => (v && typeof v === 'object' ? (v as Loose) : {});
const str = (v: unknown, max = 300): string =>
  typeof v === 'string' ? [...clean(v)].slice(0, max).join('') : '';
const strOrNull = (v: unknown, max = 300): string | null => str(v, max) || null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean) : [];
const list = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(obj) : []);
const KINDS: readonly Kind[] = ['direct', 'broadcast', 'ask', 'service'];
const kind = (v: unknown): Kind => KINDS.find((k) => k === v) ?? 'direct';
const RELATIONS: readonly Relation[] = [
  'parent',
  'child',
  'sibling',
  'same-repo',
  'correspondent',
  'mine',
  'other',
];
const relation = (v: unknown): Relation => RELATIONS.find((r) => r === v) ?? 'other';

function self(v: unknown): Self {
  const o = obj(v);
  return {
    address: str(o.address),
    aliases: strs(o.aliases),
    user: str(o.user),
    host: str(o.host),
    title: strOrNull(o.title),
    status: strOrNull(o.status),
    role: strOrNull(o.role),
    parent: strOrNull(o.parent),
    offers: strs(o.offers),
    services: strs(o.services),
    repo: strOrNull(o.repo),
    branch: strOrNull(o.branch),
  };
}

/**
 * The CLI's (or the daemon's) JSON as a Snapshot, every field checked for shape; null when it is
 * not a v1 snapshot. The text in it came from other sessions: cleaned to printable lines here,
 * bodies kept multi-line but never interpreted.
 */
export function asSnapshot(json: unknown): Snapshot | null {
  const o = obj(json);
  if (o.v !== 1) return null;
  const s = self(o.self);
  if (!s.address) return null;
  return {
    v: 1,
    at: num(o.at),
    self: s,
    socket: strOrNull(o.socket, 1000),
    peers: list(o.peers).map((p) => ({
      ...self(p),
      agent: strOrNull(p.agent),
      lastSeen: num(p.lastSeen),
      relation: relation(p.relation),
    })),
    mail: list(o.mail).map((m) => ({
      id: str(m.id),
      from: str(m.from),
      to: str(m.to),
      kind: kind(m.kind),
      area: strOrNull(m.area),
      subject: strOrNull(m.subject),
      body: typeof m.body === 'string' ? m.body.slice(0, 2000) : '',
      isTruncated: m.isTruncated === true,
      verifiedUser: str(m.verifiedUser),
      isMismatch: m.isMismatch === true,
      inReplyTo: strOrNull(m.inReplyTo),
      time: num(m.time),
    })),
    threads: list(o.threads).map((t) => ({
      with: str(t.with),
      kind: kind(t.kind),
      lastAt: num(t.lastAt),
      count: num(t.count),
      isAwaitingMe: t.isAwaitingMe === true,
      messages: list(t.messages).map((m) => ({
        id: str(m.id),
        dir: m.dir === 'out' ? ('out' as const) : ('in' as const),
        time: num(m.time),
        subject: strOrNull(m.subject),
        firstLine: str(m.firstLine, 200),
        inReplyTo: strOrNull(m.inReplyTo),
      })),
    })),
    areas: list(o.areas).map((a) => ({
      area: str(a.area),
      offeredBy: num(a.offeredBy),
      isMine: a.isMine === true,
    })),
  };
}

// ---------------------------------------------------------------- view helpers

/** Everything but the build time: equal fingerprints mean nothing to redraw. */
export const fingerprint = (s: Snapshot): string => JSON.stringify({ ...s, at: 0 });

/** "now", "45s", "12m", "3h", "2d". */
export function ago(then: number, now: number): string {
  if (!then) return '';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const CLOSE: readonly Relation[] = ['parent', 'child', 'sibling', 'correspondent'];

/**
 * Peers in four groups: working with this session (parent, children, siblings, conversations),
 * the same repo, the user's own elsewhere, everyone else; each by most recently seen.
 */
export function groupPeers(peers: Peer[]): {
  close: Peer[];
  sameRepo: Peer[];
  mine: Peer[];
  others: Peer[];
} {
  const sorted = [...peers].sort((a, b) => b.lastSeen - a.lastSeen);
  return {
    close: sorted.filter((p) => CLOSE.includes(p.relation)),
    sameRepo: sorted.filter((p) => p.relation === 'same-repo'),
    mine: sorted.filter((p) => p.relation === 'mine'),
    others: sorted.filter((p) => p.relation === 'other'),
  };
}

/** How a peer stands to this session, in words; null for the groups that say it already. */
export function relationWords(r: Relation): string | null {
  return r === 'parent'
    ? 'spawned this session'
    : r === 'child'
      ? 'spawned by this session'
      : r === 'sibling'
        ? 'same parent'
        : r === 'correspondent'
          ? 'in a conversation'
          : null;
}

/** A peer's headline: its title, else its status, else its branch, else its address label. */
export function headline(p: Pick<Peer, 'title' | 'status' | 'branch' | 'address'>): string {
  return p.title ?? p.status ?? p.branch ?? p.address.split('.').slice(2).join('.');
}

/** The address without the user and host when they are the viewer's own. */
export function shortAddr(address: string, self: Pick<Self, 'user' | 'host'>): string {
  const prefix = `${self.user}.${self.host}.`;
  return self.user && address.startsWith(prefix) ? address.slice(prefix.length) : address;
}

/** Received mail newer than `ms` ago. */
export function recentCount(mail: Snapshot['mail'], now: number, ms: number): number {
  return mail.filter((m) => now - m.time <= ms).length;
}
