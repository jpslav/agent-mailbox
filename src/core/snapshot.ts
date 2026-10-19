// `mbox snapshot --json`: everything a side panel draws about one session, as one JSON object
// (the Snapshot contract in types.ts, version 1). `buildSnapshot` assembles it from inputs the
// caller gathered (the session's state, presence, service claims, received mail and the sent log)
// and is pure; `gatherSnapshot` gathers them, for `mbox snapshot` and for the delivery daemon's
// snapshot socket (uiserver.ts), which passes the presence it already holds.
//
// Every free-text field (bodies, subjects, titles, statuses) is untrusted and passed on as is (only
// cut to length): whoever draws it must draw it as plain text.
import { BROADCAST, parseAddr } from './addr.js';
import { areaAddress, areaOf, checkOffers } from './areas.js';
import { oneLine, parseDelivery } from './envelope.js';
import { cutSubject, cutText, kindOf, readSentLog } from './sentlog.js';
import { gitInfo } from './session-meta.js';
import { parseService } from './services.js';
import type {
  Delivery,
  Env,
  PeerRelation,
  PresenceEntry,
  SentRecord,
  ServiceClaim,
  SessionState,
  Snapshot,
  SnapshotArea,
  SnapshotMail,
  SnapshotPeer,
  SnapshotThread,
  SnapshotThreadMessage,
  Transport,
} from './types.js';

/** A received body is cut to this many characters. */
export const SNAPSHOT_BODY_MAX = 2000;
/** A thread message's first line is cut to this many characters. */
export const FIRST_LINE_MAX = 200;
/** The default lookback. */
export const SNAPSHOT_SINCE = '24h';
/** What a lookback looks like: a number and a unit (30m, 2h, 1d). */
export const SINCE_RE = /^\d{1,6}[smhd]$/;
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
/** The milliseconds in a lookback that matches SINCE_RE. */
export const sinceToMs = (since: string): number =>
  parseInt(since, 10) * UNIT_MS[since.slice(-1) as keyof typeof UNIT_MS];
/**
 * One spelling per lookback, in the largest unit that divides it (`60m` and `3600s` are `1h`), so
 * equal lookbacks share a cache entry.
 */
export function canonicalSince(since: string): string {
  const ms = sinceToMs(since);
  for (const [unit, n] of [
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
  ] as const)
    if (ms > 0 && ms % n === 0) return `${ms / n}${unit}`;
  return `${ms / UNIT_MS.s}s`;
}
/** The longest lookback a snapshot accepts. */
export const SNAPSHOT_SINCE_MAX_MS = 30 * 86400000;
/** A snapshot lists at most this many received messages: the newest. */
export const SNAPSHOT_MAIL_MAX = 200;
/** Ids, addresses and timestamps from the wire are cut to this many characters. */
const FIELD_MAX = 256;
const cutField = (s: string): string => cutText(s, FIELD_MAX).text;
const cutNullable = (s: string | null): string | null => (s === null ? null : cutField(s));

export interface SnapshotInput {
  /** When it is built (ms since the epoch). */
  now: number;
  /** The lookback as given (`24h`), and in ms. */
  since: string;
  sinceMs: number;
  socket: string | null;
  /** The configured mailbox user. */
  user: string;
  /** The session's id and state. */
  sid: string;
  state: SessionState;
  /** The repository and branch of the session's working directory. */
  repo: string | null;
  branch: string | null;
  /** transport.presence.list() */
  peers: PresenceEntry[];
  /** transport.services.list() (empty when unreadable) */
  claims: ServiceClaim[];
  /**
   * Received mail: what `mbox inbox` reads for the session (its addresses, the services it holds,
   * broadcasts, asks in the areas it offers), oldest first.
   */
  deliveries: Delivery[];
  /** The session's sent log, oldest first. */
  sent: SentRecord[];
}

/** The first non-blank line of a body as one line of printable text, cut to FIRST_LINE_MAX. */
export function firstLine(body: string): string {
  const line =
    body
      .split(/\r\n?|\n/)
      .map((l) => l.trim())
      .find((l) => l) ?? '';
  return oneLine(line, FIRST_LINE_MAX);
}

/**
 * The received mail as the snapshot lists it, own broadcasts and asks skipped (as inbox does): the
 * newest SNAPSHOT_MAIL_MAX, oldest first.
 */
export function snapshotMail(input: SnapshotInput): SnapshotMail[] {
  const { state: st, user } = input;
  const names = [st.address, ...st.aliases];
  const cutoff = input.now - input.sinceMs;
  const out: SnapshotMail[] = [];
  for (const d of input.deliveries) {
    const m = parseDelivery(d);
    const kind = kindOf(d.to); // where the transport read it, never the envelope's claim
    const shared = kind === 'broadcast' || kind === 'ask';
    if (shared && m.sender === user && names.includes(m.from)) continue;
    const time = m.time * 1000;
    if (time < cutoff) continue;
    const { text, isTruncated } = cutText(m.body, SNAPSHOT_BODY_MAX);
    const claimed = m.raw ? null : (m.from.split('.')[0] ?? null);
    out.push({
      id: cutField(m.id),
      from: cutField(m.from),
      to: cutField(d.to),
      kind,
      area: areaOf(d.to),
      subject: cutSubject(m.subject),
      body: text,
      isTruncated,
      verifiedUser: m.sender,
      isMismatch: !!m.sender && claimed !== null && claimed !== m.sender,
      inReplyTo: cutNullable(m.inReplyTo),
      sentAt: cutNullable(m.sentAt),
      time,
    });
  }
  return out.sort((a, b) => a.time - b.time).slice(-SNAPSHOT_MAIL_MAX);
}

/**
 * The thread of received direct mail: its sender's address, when that is a session address of the
 * user the server verified; otherwise `unverified:<user>`, so a forged `from` can neither join
 * another session's thread nor pose as 'all' or an area.
 */
function senderKey(m: SnapshotMail): string {
  const addr = parseAddr(m.from);
  return addr && m.verifiedUser && addr.user === m.verifiedUser
    ? m.from
    : `unverified:${m.verifiedUser ?? '?'}`;
}

/**
 * Pair received and sent mail into one thread per counterpart. Received mail to 'all' or to an
 * area belongs to that address's thread; received direct mail, and mail to a service address this
 * session holds, to its sender's thread (senderKey); sent mail to its recipient's. A message that answers (inReplyTo) one in the
 * snapshot joins that message's thread instead, so the replies to an ask or a broadcast stay with
 * it (whatever the clocks of sender and server say about their order).
 */
export function buildThreads(mail: SnapshotMail[], sent: SentRecord[]): SnapshotThread[] {
  type Item = SnapshotThreadMessage & { base: string };
  const items: Item[] = [
    ...mail.map((m) => ({
      id: m.id,
      dir: 'in' as const,
      time: m.time,
      subject: m.subject,
      firstLine: firstLine(m.body),
      inReplyTo: m.inReplyTo,
      // Mail to one of my own service addresses is a conversation with its sender, as direct
      // mail is: keyed by the service, every caller would share one thread.
      base: m.kind === 'direct' || m.kind === 'service' ? senderKey(m) : m.to,
    })),
    ...sent.map((s) => ({
      id: s.id,
      dir: 'out' as const,
      time: s.time,
      subject: s.subject,
      firstLine: firstLine(s.body),
      inReplyTo: s.inReplyTo,
      base: s.to,
    })),
  ].sort((a, b) => a.time - b.time || (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1));
  const byId = new Map<string, Item>();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
  const keyOf = (it: Item, seen = new Set<Item>()): string => {
    seen.add(it);
    const parent = it.inReplyTo ? byId.get(it.inReplyTo) : undefined;
    return parent && !seen.has(parent) ? keyOf(parent, seen) : it.base;
  };
  const threads = new Map<string, Item[]>();
  for (const it of items) {
    const key = keyOf(it);
    const list = threads.get(key);
    if (list) list.push(it);
    else threads.set(key, [it]);
  }
  const out: SnapshotThread[] = [];
  for (const [key, list] of threads) {
    const last = list[list.length - 1]!; // every thread has at least one message
    out.push({
      with: key,
      kind: key.startsWith('unverified:') ? 'direct' : kindOf(key),
      lastAt: last.time,
      count: list.length,
      isAwaitingMe: last.dir === 'in',
      messages: list.map((m) => ({
        id: m.id,
        dir: m.dir,
        time: m.time,
        subject: m.subject,
        firstLine: m.firstLine,
        inReplyTo: m.inReplyTo,
      })),
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** Who holds which service, by session: only claims of the peer's own user count. */
function servicesOf(p: Pick<PresenceEntry, 'session' | 'user'>, claims: ServiceClaim[]): string[] {
  return claims
    .filter((c) => c.session === p.session && parseService(c.service)?.user === p.user)
    .map((c) => c.service)
    .sort();
}

/**
 * Each live peer's relation to this session (PeerRelation; the first that applies). Parent, child
 * and sibling follow the self-asserted parent links, resolved through the live sessions' addresses
 * and aliases: display only.
 */
export function peerRelations(
  self: { sid: string; user: string; state: SessionState; repo: string | null },
  peers: PresenceEntry[],
  threads: SnapshotThread[],
  claims: ServiceClaim[],
): Map<PresenceEntry, PeerRelation> {
  const st = self.state;
  const selfKey = `${self.user}\n${self.sid}`;
  const owner = new Map<string, string>(); // name -> session key
  for (const n of [st.address, ...st.aliases]) owner.set(n, selfKey);
  for (const p of peers)
    for (const n of [p.address, ...p.aliases])
      if (!owner.has(n)) owner.set(n, `${p.user}\n${p.session}`);
  const canon = (name: string | null | undefined): string | null =>
    name ? (owner.get(name) ?? name) : null;
  const myParent = canon(st.parent);
  const counterparts = new Set(threads.map((t) => t.with));
  const out = new Map<PresenceEntry, PeerRelation>();
  for (const p of peers) {
    const key = `${p.user}\n${p.session}`;
    const theirParent = canon(p.parent);
    const names = [p.address, ...p.aliases, ...servicesOf(p, claims)];
    let rel: PeerRelation;
    if (myParent && myParent === key) rel = 'parent';
    else if (theirParent === selfKey) rel = 'child';
    else if (myParent && theirParent === myParent) rel = 'sibling';
    else if (self.repo && p.repo === self.repo) rel = 'same-repo';
    else if (names.some((n) => counterparts.has(n))) rel = 'correspondent';
    else if (p.user === self.user) rel = 'mine';
    else rel = 'other';
    out.set(p, rel);
  }
  return out;
}

/** The areas live sessions offer, with how many do and whether this session is one of them. */
export function snapshotAreas(mine: string[], peers: PresenceEntry[]): SnapshotArea[] {
  const count = new Map<string, number>();
  for (const a of mine) count.set(a, 1);
  for (const p of peers) for (const a of p.offers) count.set(a, (count.get(a) ?? 0) + 1);
  return [...count.entries()]
    .map(([area, offeredBy]) => ({ area, offeredBy, isMine: mine.includes(area) }))
    .sort((a, b) => (a.area < b.area ? -1 : a.area > b.area ? 1 : 0));
}

/** Assemble the snapshot (pure: everything comes from `input`). */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { state: st, sid, user, sinceMs, now } = input;
  const cutoff = now - sinceMs;
  const others = input.peers.filter(
    (p) => p.live && !(p.user === user && p.session === sid) && p.address !== st.address,
  );
  const mail = snapshotMail(input);
  const sent = input.sent.filter((s) => s.time >= cutoff).sort((a, b) => a.time - b.time);
  const threads = buildThreads(mail, sent);
  const offers = checkOffers(st.offers);
  const relations = peerRelations(
    { sid, user, state: st, repo: input.repo },
    others,
    threads,
    input.claims,
  );
  const peers: SnapshotPeer[] = [...others]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((p) => ({
      address: p.address,
      aliases: p.aliases,
      user: p.user,
      host: p.host,
      agent: p.agent,
      title: p.title ?? null,
      status: p.status,
      role: p.role,
      parent: p.parent,
      repo: p.repo,
      branch: p.branch,
      offers: p.offers,
      services: servicesOf(p, input.claims),
      lastSeen: p.lastSeen,
      relation: relations.get(p) ?? 'other',
    }));
  return {
    v: 1,
    at: now,
    since: input.since,
    socket: input.socket,
    self: {
      address: st.address,
      aliases: st.aliases,
      user,
      host: parseAddr(st.address)?.host ?? null,
      title: st.title ?? null,
      status: st.status ?? null,
      role: st.role ?? null,
      parent: st.parent ?? null,
      offers,
      services: st.services ?? [],
      repo: input.repo,
      branch: input.branch,
    },
    peers,
    mail,
    sent,
    threads,
    areas: snapshotAreas(offers, others),
  };
}

/** The addresses whose mail a snapshot reads: as `mbox inbox` (own names, services, 'all', areas). */
export function snapshotAddresses(st: SessionState): string[] {
  return [
    st.address,
    ...st.aliases,
    ...(st.services ?? []),
    BROADCAST,
    ...(st.offers ?? []).map(areaAddress),
  ];
}

export interface GatherInput {
  transport: Pick<Transport, 'presence' | 'services' | 'poll'>;
  user: string;
  sid: string;
  state: SessionState;
  since: string;
  sinceMs: number;
  socket: string | null;
  /** Presence and claims already at hand (else read from the transport). */
  peers?: PresenceEntry[];
  claims?: ServiceClaim[];
  env?: Env;
}

/** Read what a snapshot needs (the server, the session's git checkout, its sent log) and build it. */
export async function gatherSnapshot(i: GatherInput): Promise<Snapshot> {
  const [peers, claims, deliveries] = await Promise.all([
    i.peers ?? i.transport.presence.list(),
    i.claims ?? i.transport.services.list().catch((): ServiceClaim[] => []),
    // Everything in the window, so the newest are among it (buildSnapshot keeps the newest).
    i.transport.poll(snapshotAddresses(i.state), { lookbackMs: i.sinceMs, max: Infinity }),
  ]);
  const { repo, branch } = gitInfo(i.state.cwd);
  return buildSnapshot({
    now: Date.now(),
    since: i.since,
    sinceMs: i.sinceMs,
    socket: i.socket,
    user: i.user,
    sid: i.sid,
    state: i.state,
    repo,
    branch,
    peers,
    claims,
    deliveries,
    sent: readSentLog(i.sid, i.env),
  });
}
