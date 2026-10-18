// Broker transport backed by a NATS server with JetStream (https://docs.nats.io). This is the ONLY
// file that knows about NATS: subjects, streams, consumers, the KV bucket, acks and permission
// errors. Core code (everything outside src/core/transport/) talks to the interface below.
//
// ---- Transport interface (what core may rely on) ----------------------------------------------
//
// Addresses are the core's `<user>.<host>.<label>` strings and service addresses `<user>.<name>`
// (src/core/services.ts), plus the broadcast pseudo-address 'all' and a help area's pseudo-address
// `area:<area>` (src/core/areas.ts): mail to an area is an ask.
//
//   publish(to, envelope, {timeoutMs}) -> {id}
//       Deliver `envelope` (a JSON-able object with a unique `.id`) to one address, 'all' or an area. The
//       broker stores it durably for its retention period; retries with the same id are deduped.
//       Throws TooLargeError (`.tooLarge === true`) when the broker would refuse the size.
//
//   subscribe({session, addresses, cursor, signal, onOpen, onMessage, redeliverAfterMs}) -> Promise<never>
//       Deliver mail for `addresses` plus broadcasts. `session` names a durable server-side
//       position, so mail that arrives while nobody is watching is queued. `cursor` (opaque, from
//       now() or delivery.cursor) is only used when that durable position has to be rebuilt.
//       Delivery is at-least-once: onMessage may be async and its resolution is the
//       acknowledgement; a crash before that means redelivery, so the caller dedupes by id.
//       onMessage calls never overlap. Deferred acknowledgement: if onMessage resolves to
//       {ackAfter: Promise}, the next delivery is offered right away and this one is
//       acknowledged when ackAfter resolves; if it rejects, the delivery is handed back for
//       redelivery (soon, not after redeliverAfterMs). Ending the subscription (signal) first
//       stops taking deliveries, then waits up to `settleMs` (default 3 s) for the ones already
//       handed to onMessage to be acknowledged or handed back, then hands back everything not
//       acknowledged at once and oldest first. A delivery the server sends in the instant the
//       subscription ends is seen by nobody and comes back after redeliverAfterMs.
//       Order: mail for the session's addresses reaches onMessage in stream order (the order the
//       server stored it; for one sender, the order of sending), also across subscribers. A
//       subscription that starts while earlier deliveries are still unacknowledged (handed back,
//       lost in that instant, or held by a reader that crashed) holds everything it receives
//       until they are all back, then offers it sorted; it gives up waiting a little after
//       redeliverAfterMs (redeliverAfterMs + max(5 s, half of it)) and offers what it has.
//       Broadcasts are in order among themselves, not relative to direct mail; they have no
//       server-side acknowledgement: the caller's saved cursor is their position. Asks in the
//       areas among `addresses` work the same way, in order within each area; an area the cursor
//       has no position for is read from its oldest stored ask (a session that starts offering an
//       area gets what was asked there within the retention). A server without asks (provisioned
//       before them) only means no asks: mail and broadcasts are unaffected. Service addresses
//       among `addresses` (the session's own user's) are read from the service's own durable
//       position, shared by whoever holds the service, with the same ordering and hand-back as
//       the session's mail; before each message the subscription checks that the service's claim
//       still names `session`, and when it does not (another session took it over, or it was
//       released) it hands the message back at once, stops reading that service and calls
//       onServiceLost(service). onOpen() is
//       called each time the subscription is (re)established. The promise never resolves: it
//       rejects when the connection ends, or with an AbortError when `signal` aborts. Errors with `.authProblem === true` mean
//       credentials/permissions. Calling subscribe again with different addresses re-targets the
//       same durable position (aliases). An unacknowledged delivery is redelivered after
//       `redeliverAfterMs` (default 60 s).
//
//   poll(addresses, {lookbackMs, max}) -> delivery[]       (oldest first; no side effects; at most
//       `max` per address, default 256, Infinity pages through everything in the window)
//
//   now() -> cursor                  the "start from here" cursor for a brand-new session
//
//   presence.announce(rec) / .heartbeat(rec) / .depart(rec, {timeoutMs}) / .update(rec)
//   presence.list() -> peer[]
//       rec  = {address, aliases[], session, agent, user, host, cwd, pid}
//       peer = rec + {lastSeen(ms), live: true}
//       announce/heartbeat = "I'm online" (core sends one every 10 minutes); depart = "I'm gone";
//       update = change metadata (aliases) without asserting liveness. A record expires on its
//       own when it is not refreshed (bucket TTL); list() returns only live records whose user
//       is the server-verified writer.
//
//   events.publish(ev, {timeoutMs})  append an event to the own user's feed
//   events.read(user, {sinceMs, max}) -> entry[]   a user's feed, oldest first; `.notShared` error
//       when the server does not let this user read it (private, or no such user)
//   events.shared() -> user[] | null  the users whose feed the admin shares with the team
//
//   services.read(service) -> {claim, version}     the claim on a service address (version 0: none)
//   services.write(claim, version) -> boolean       compare-and-set: false when it changed since read
//   services.remove(service, version) -> boolean    release, compare-and-set
//   services.list() -> claim[]       every user's current claims
//
//   asksReadable() -> boolean        can this user read asks (false: a server set up before them)
//   limits.maxLabelLen(user, host)   longest label that still forms a routable address
//   explainError(err) -> string      human-readable message for any error thrown above
//   diagnose({user, host}) -> [{ok, name, hint?}]       connectivity / auth / permission self-check
//   close()                          release connections (call before exiting)
//
// createTransport(cfg, {multiplex, faults}): with multiplex: true (a long-running process serving
// many sessions), every subscribe() and every request-style call share ONE connection; ending a
// subscription leaves it open, and close() releases it. Without it, each subscribe() has its own.
// `faults` are test-only knobs (TransportFaults in types.ts).
//
// delivery = {id, time(unix s), to ('all' | address | service | 'area:<area>'), sender
//             (server-verified user), payload (string as published), cursor}
// -------------------------------------------------------------------------------------------------
//
// NATS mapping
//   direct mail   mbx.<toUser>.<toHost>.<toLabel>.<fromUser>   stream MBX_<TOUSER> (mbx.<user>.>)
//   broadcast     mbx.all.<fromUser>                           stream MBX_ALL      (mbx.all.*)
//   presence      KV bucket `presence`, key <user>.<host>.<session hash>
//   events        evt.<user>.<host>                            stream EVT_<USER>   (evt.<user>.*)
//   sharing       KV bucket `sharing`, key `team` = JSON list of the users whose feed is shared
//   ask           ask.<area token>.<fromUser>                  stream ASKS         (ask.*.*)
//                 (area token: 32 hex of sha256(area); readers map it back from the areas they offer)
//   service mail  mbx.<toUser>._svc.<name>.<fromUser>          stream MBX_<TOUSER> (mbx.<user>.>)
//   service claim KV bucket `presence`, key <user>._svc.<name>
// Service mail to <user>.<name> is direct mail in form: the `_svc` token cannot be a host (hosts
// are [a-z0-9-]+), the sender is the last token, and the server's existing rules apply unchanged
// (anyone may publish mbx.*.*.*.<own name>, only <user> reads MBX_<USER>). One durable pull
// consumer per service, `svc=<name>` on the owner's stream (a name no session id maps to: see
// consumerName), filtered to the service's subject, is the service's position: whoever holds the
// service reads through it, so a new holder gets what earlier holders left. Claims are entries in
// the presence bucket that only <user> may write; compare-and-set on the entry's last sequence
// keeps two claims from both winning, and the bucket's TTL ends a claim whose holder stops
// refreshing it.
// Only <user> may publish evt.<user>.*, so a feed's owner is verified by the stream it is in. The
// stream's subject must be a wildcard, like every stream here: the server sends a push consumer's
// deliveries to a literal stream subject (it counts as interest), so anyone could write into a
// literal-subject stream through a push consumer on their own mailbox stream, whatever their
// publish permissions say; test/isolation.test.ts proves that wildcard streams get nothing. Feeds
// are read with direct gets; the server lets a user read another's feed only while the admin
// shares it with the team (the permission block lists exactly those streams). The sharing list is
// written by the admin and only says what the permissions already decide.
// The trailing <fromUser> token is enforced by the server's publish permissions, so it is the
// verified sender. Each session reads its own stream through one durable pull consumer named after
// the session (filter = this session's addresses, explicit ack); broadcasts are read with direct
// gets from a locally remembered sequence (no consumer on the shared stream, so nobody needs
// consumer rights there). Asks are read the same way, per area, from ASKS, which every user reads
// and each user writes only under their own name (the last token), like broadcasts; their wake-up
// is the stored ask's headers, republished to mbxwake.ask.* and imported by every user account as
// ask.*.*. Request replies use a per-user inbox prefix _INBOX_<user>.
import crypto from 'node:crypto';
import { connect } from '@nats-io/transport-node';
import type { ConnectionOptions, NatsConnection, Subscription } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type {
  ConsumerConfig,
  ConsumerInfo,
  ConsumerMessages,
  DirectBatchOptions,
  JsMsg,
  JetStreamClient,
  JetStreamManager,
} from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import type { KV } from '@nats-io/kv';
import { SEG_RE } from '../addr.js';
import { AREA_PREFIX, areaAddress, areaOf, checkOffers } from '../areas.js';
import { checkEvent } from '../events.js';
import { isService, parseService } from '../services.js';
import { checkBranch, checkParent, checkRepo, checkRole, checkStatus } from '../session-meta.js';
import type {
  Cursor,
  Delivery,
  DiagnoseCheck,
  Envelope,
  Events,
  FeedEntry,
  PollOptions,
  Presence,
  PresenceEntry,
  PresenceOptions,
  PresenceRecord,
  ServiceClaim,
  Services,
  SubscribeOptions,
  Transport,
  TransportOptions,
} from '../types.js';

const PREFIX = 'mbx';
const ALL_STREAM = 'MBX_ALL';
const BUCKET = 'presence';
const BUCKET_STREAM = `KV_${BUCKET}`;
const MAX_ADDR_LEN = 128;
const NS = 1_000_000;
const INACTIVE_NS = 30 * 86400_000 * NS;
const DOCTOR_LABEL = 'mbox-doctor';
const EVT_PREFIX = 'evt';
const SHARING_BUCKET = 'sharing';
const SHARING_STREAM = `KV_${SHARING_BUCKET}`;
const SHARING_KEY = 'team';
const ASK_PREFIX = 'ask';
/** Not MBX_ASK: `ask` is a valid user name, whose mailbox stream that would be. */
const ASK_STREAM = 'ASKS';
/** At most this many area positions are kept in a cursor (more only after many offer changes). */
const MAX_AREA_POSITIONS = 64;
/** The subject token (and claim key token) of service addresses: no host can be called that. */
const SVC = '_svc';
/** Service consumers are `svc=<name>`: consumerName never yields an '=', so no session's can be. */
const SVC_CONSUMER = 'svc=';

// ---------------------------------------------------------------- names
function parseAddr(s: unknown): [string, string, string] | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  return parts.length === 3 && parts.every((p) => SEG_RE.test(p))
    ? (parts as [string, string, string])
    : null;
}

/** MBX_<USER>: users are [a-z0-9-]+ (no '_'), so mapping '-' to '_' cannot collide. */
export const streamFor = (user: string): string =>
  `${PREFIX.toUpperCase()}_${user.toUpperCase().replace(/-/g, '_')}`;

/** EVT_<USER>: a user's events feed (same mapping as streamFor). */
export const eventsStreamFor = (user: string): string =>
  `${EVT_PREFIX.toUpperCase()}_${user.toUpperCase().replace(/-/g, '_')}`;

/** The subject token of a help area: fixed length, and safe whatever characters the area uses. */
export const areaToken = (area: string): string =>
  crypto.createHash('sha256').update(area).digest('hex').slice(0, 32);

/** The subject service mail to `user`'s service `name` from `fromUser` is stored under. */
const serviceSubject = (user: string, name: string, fromUser: string): string =>
  `${PREFIX}.${user}.${SVC}.${name}.${fromUser}`;

export function subjectFor(to: string, fromUser: string): string {
  if (!SEG_RE.test(fromUser || '')) throw new Error(`invalid sender user "${fromUser}"`);
  if (to === 'all') return `${PREFIX}.all.${fromUser}`;
  const svc = parseService(to);
  if (svc) return serviceSubject(svc.user, svc.name, fromUser);
  const area = areaOf(to);
  if (area !== null) return `${ASK_PREFIX}.${areaToken(area)}.${fromUser}`;
  if (to.startsWith(AREA_PREFIX)) throw new Error(`invalid area in "${to}"`);
  const p = parseAddr(to);
  if (!p)
    throw new Error(`invalid address "${to}" (expected <user>.<host>.<label>, each [a-z0-9-]+)`);
  if (p[0] === 'all') throw new Error(`invalid address "${to}": "all" is reserved`);
  return `${PREFIX}.${p.join('.')}.${fromUser}`;
}

/** subject -> {to, sender} or null for subjects outside the mailbox namespace. */
export function parseSubject(subject: string): { to: string; sender: string } | null {
  const t = String(subject || '').split('.');
  if (t[0] !== PREFIX) return null;
  const [, second, third] = t;
  if (t.length === 3 && second === 'all' && third !== undefined && SEG_RE.test(third))
    return { to: 'all', sender: third };
  if (t.length === 5 && third === SVC) {
    const to = `${second}.${t[3]}`;
    return isService(to) && SEG_RE.test(t[4]!) ? { to, sender: t[4]! } : null; // length is 5
  }
  if (t.length === 5 && t.slice(1).every((x) => SEG_RE.test(x)))
    return { to: t.slice(1, 4).join('.'), sender: t[4]! }; // length is 5
  return null;
}

/** ask.<token>.<sender> -> {token, sender}, or null for any other subject. */
export function parseAskSubject(subject: string): { token: string; sender: string } | null {
  const t = String(subject || '').split('.');
  if (t.length !== 3 || t[0] !== ASK_PREFIX || !/^[0-9a-f]{32}$/.test(t[1] ?? '')) return null;
  return SEG_RE.test(t[2] ?? '') ? { token: t[1]!, sender: t[2]! } : null; // length is 3
}

/**
 * Durable consumer name for a session id (consumer names may not contain '.', '*', '>' or spaces).
 * Never contains '=', which keeps the service consumers' names (`svc=<name>`) apart.
 */
export function consumerName(sid: string): string {
  const s = String(sid);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s;
  return `s-${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
}

const sessionShort = (sid: string): string =>
  crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 12);
export const presenceKey = (user: string, host: string, sid: string): string =>
  `${user}.${host}.${sessionShort(sid)}`;

/** The presence-bucket key of a service's claim: `<user>._svc.<name>`. */
const claimKey = (service: string): string => {
  const p = parseService(service);
  if (!p) throw new Error(`invalid service address "${service}"`);
  return `${p.user}.${SVC}.${p.name}`;
};

/** A claim entry as stored: written by the service's user, so nothing in it is trusted. */
interface UntrustedClaim {
  service?: unknown;
  holder?: unknown;
  session?: unknown;
  at?: unknown;
}

/**
 * A stored claim entry -> a checked claim, or null when the entry is not a well-formed claim. The
 * key says whose service it is (only that user may write it): the claim must name that service
 * and a session address of that user. Claims have no `address` field, so readers of presence
 * entries (this version and every earlier one) skip them.
 */
function checkClaim(key: string, data: Uint8Array, timeMs: number): ServiceClaim | null {
  const t = key.split('.');
  if (t.length !== 3 || t[1] !== SVC) return null;
  const service = `${t[0]}.${t[2]}`;
  const p = parseService(service);
  if (!p) return null;
  let j: UntrustedClaim | null;
  try {
    j = JSON.parse(td.decode(data)) as UntrustedClaim | null;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.service !== service) return null;
  if (parseAddr(j.holder)?.[0] !== p.user) return null;
  if (typeof j.session !== 'string' || !j.session || j.session.length > 256) return null;
  return {
    service,
    holder: j.holder as string, // parseAddr accepted it, so it is a string
    session: j.session,
    at: typeof j.at === 'string' && j.at.length <= 64 ? j.at : null,
    lastSeen: timeMs,
  };
}

/** The claim on `service` and its entry's version (0: no entry), read with one direct get. */
async function readClaim(
  jsm: JetStreamManager,
  service: string,
): Promise<{ claim: ServiceClaim | null; version: number }> {
  const key = claimKey(service);
  let m: Awaited<ReturnType<JetStreamManager['direct']['getMessage']>>;
  try {
    m = await jsm.direct.getMessage(BUCKET_STREAM, { last_by_subj: `$KV.${BUCKET}.${key}` });
  } catch (e) {
    if (/message not found|no message/i.test(String(shape(e)?.message)))
      return { claim: null, version: 0 };
    throw tag(e);
  }
  if (!m) return { claim: null, version: 0 };
  const op = m.header.get('KV-Operation');
  const claim = op === 'DEL' || op === 'PURGE' ? null : checkClaim(key, m.data, m.time.getTime());
  return { claim, version: m.seq };
}

const maxLabelLen = (user: string, host: string): number =>
  MAX_ADDR_LEN - (user.length + 1 + host.length + 1);

// ---------------------------------------------------------------- errors
export class TooLargeError extends Error {
  readonly tooLarge = true;

  constructor(size: number, limit: number) {
    super(
      `message is ${size} bytes but the server accepts at most ${limit} bytes per message (max_payload). Send less, or raise max_payload on the server.`,
    );
  }
}

/**
 * What the code below reads from a thrown value. Anything can be thrown (the NATS client, Node and
 * this file throw different shapes), so every field is optional and checked where it is used.
 */
interface ErrorShape {
  name?: string;
  message?: string;
  code?: unknown;
  api_error?: { err_code?: unknown };
  cause?: { code?: string };
  operation?: string;
  subject?: string;
  tooLarge?: boolean;
  authProblem?: boolean;
}

/** A thrown value, viewed through ErrorShape. */
const shape = (e: unknown): ErrorShape | null | undefined => e as ErrorShape | null | undefined;

const isPermission = (e: unknown): boolean =>
  shape(e)?.name === 'PermissionViolationError' ||
  /permissions violation/i.test(String(shape(e)?.message || ''));
const isAuth = (e: unknown): boolean =>
  shape(e)?.name === 'AuthorizationError' ||
  /authorization violation|authentication/i.test(String(shape(e)?.message || ''));
const isNoStream = (e: unknown): boolean =>
  shape(e)?.name === 'NoRespondersError' ||
  shape(e)?.code === 10059 ||
  shape(e)?.api_error?.err_code === 10059 ||
  /no responders|stream not found|jetstream is not enabled/i.test(String(shape(e)?.message || ''));
/**
 * A permission violation about asks: a server provisioned before them refuses this user the ask
 * subjects. That only means no asks, so it must not end the subscriptions on the connection.
 */
const isAskPermission = (e: unknown): boolean => {
  if (!isPermission(e)) return false;
  const subject = shape(e)?.subject ?? /"([^"]+)"/.exec(String(shape(e)?.message || ''))?.[1];
  return (
    subject === `$JS.API.DIRECT.GET.${ASK_STREAM}` ||
    String(subject || '').startsWith(`${ASK_PREFIX}.`)
  );
};
/** A compare-and-set write that lost: the entry is no longer at the expected sequence. */
const isWrongLastSeq = (e: unknown): boolean =>
  shape(e)?.code === 10071 ||
  shape(e)?.api_error?.err_code === 10071 ||
  /wrong last sequence/i.test(String(shape(e)?.message || ''));
const isNotFound = (e: unknown): boolean =>
  shape(e)?.code === 10014 ||
  shape(e)?.api_error?.err_code === 10014 ||
  /consumer not found/i.test(String(shape(e)?.message || ''));

/** Flag credential / permission errors so callers can say "auth problem" (`.authProblem`). */
function tag<E>(e: E): E {
  if (e && typeof e === 'object' && (isPermission(e) || isAuth(e)))
    (e as ErrorShape).authProblem = true;
  return e;
}

export function explainError(e: unknown): string {
  const err = shape(e);
  if (err?.tooLarge) return err.message ?? '';
  if ((err as { notShared?: boolean } | null | undefined)?.notShared) return err?.message ?? '';
  if (isAuth(e))
    return 'authentication failed: the user name or password is wrong (or the user was removed). Re-run `mbox setup` with the credentials from the mailbox admin.';
  if (isPermission(e)) {
    const m = String(err?.message || '').match(/(Publish|Subscription) to "([^"]+)"/i);
    const what =
      err?.operation && err.subject
        ? ` (${err.operation} ${err.subject})`
        : m
          ? ` (${m[1]!.toLowerCase()} ${m[2]})`
          : ''; // a match has both groups
    return `permission denied by the server${what}. Ask the mailbox admin to check your user's permissions.`;
  }
  if (err?.name === 'TimeoutError') return 'request timed out (is the server reachable?)';
  if (err?.name === 'AbortError') return 'aborted';
  if (err?.name === 'NoRespondersError' || /no responders/i.test(String(err?.message || ''))) {
    return 'the server has no stream for that address (JetStream did not answer). Check the recipient user exists, or ask the admin to run `mbox-admin.sh add-user`.';
  }
  if (
    err?.name === 'ConnectionError' ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|connection refused/i.test(
      String(err?.message || '') + String(err?.cause?.code || ''),
    )
  ) {
    return `cannot reach the mailbox server (${err?.message}${err?.cause?.code ? `, ${err.cause.code}` : ''})`;
  }
  return err?.message || String(e);
}

// ---------------------------------------------------------------- config
/** A server URL must be nats://host:port or tls://host:port. */
export function validateServer(server: string): void {
  if (!/^(nats|tls):\/\/[^\s/:]+(:\d+)?\/?$/.test(String(server)))
    throw new Error(`server must look like nats://host:4222, got "${server}"`);
}

const td = new TextDecoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- transport

/** A stored message as read from a stream, before it becomes a Delivery. */
interface StoredMessage {
  subject: string;
  seq: number;
  stream: string;
  timeMs: number;
  data: Uint8Array;
  /** The dedupe id the publisher set, if any. */
  msgId: string | null;
}

/** A presence entry as stored: written by the user it belongs to, so nothing in it is trusted. */
interface UntrustedPresence {
  address?: unknown;
  session?: unknown;
  aliases?: unknown;
  agent?: unknown;
  cwd?: unknown;
  pid?: unknown;
  repo?: unknown;
  branch?: unknown;
  role?: unknown;
  parent?: unknown;
  status?: unknown;
  offers?: unknown;
}

/**
 * The position of a receiver: last sequence read from the own stream, from the broadcast stream
 * and, per area token, from the asks stream.
 */
interface NatsCursor {
  u: number | null;
  a: number | null;
  /** Area token -> last sequence read in ASKS for that area (absent before 0.6.1: none read). */
  k?: Record<string, number>;
  /** Where to start when there is no sequence yet (ISO-8601). */
  t: string;
}

/** One durable consumer a subscription reads (the session's own, or a claimed service's). */
interface Puller {
  messages: ConsumerMessages | null;
  /** Takes each message; ends (resolves) only when a service is lost, else rejects. */
  loop: Promise<void> | null;
  /** Mail held until the messages owed from the consumer's previous reader are back. */
  gate: {
    held: Map<number, JsMsg>; // by stream sequence; a redelivery replaces the older copy
    back: Set<number>; // owed sequences received
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Offering what the gate held; later mail waits for it. */
  released: Promise<void>;
}

/** What `createTransport` needs from the client config (`Config` satisfies it). */
export interface TransportConfig {
  servers: string | string[];
  user: string;
  password: string;
}

/** One open connection with its JetStream clients. */
interface Shared {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  /** The presence bucket, opened on first use. */
  kv: KV | null;
  /** Whether this user can read asks, once known. */
  asks: boolean | null;
  /** In multiplex mode: the failure callbacks of the subscriptions riding on this connection. */
  subs: Set<(reason: unknown) => void>;
}

export function createTransport(
  cfg: TransportConfig,
  { multiplex = false, faults = {} }: TransportOptions = {},
): Transport {
  const servers = Array.isArray(cfg.servers) ? cfg.servers : [cfg.servers];
  if (!servers.length) throw new Error('no server configured');
  servers.forEach(validateServer);
  const user = cfg.user;
  const ownStream = streamFor(user);
  const connOpts = (extra: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
    servers,
    user,
    pass: cfg.password,
    name: `mbox ${user}`,
    inboxPrefix: `_INBOX_${user}`,
    reconnect: false,
    timeout: 5000,
    ...extra,
  });

  // One lazily opened connection for request-style calls (publish, presence, poll, diagnose).
  let shared: Promise<Shared> | null = null;
  async function conn({ timeoutMs }: { timeoutMs?: number } = {}): Promise<Shared> {
    while (shared) {
      const pending = shared;
      const s = await pending.catch(() => null);
      if (s && !s.nc.isClosed()) return s;
      if (shared === pending) shared = null; // else another caller already started a new one
    }
    shared = (async () => {
      const nc = await connect(
        connOpts({
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
          ...(multiplex ? { pingInterval: 20000, maxPingOut: 2 } : {}),
        }),
      );
      const js = jetstream(nc, { checkAPI: false, timeout: timeoutMs || 10000 });
      const jsm = await jetstreamManager(nc, { checkAPI: false, timeout: timeoutMs || 10000 });
      const s: Shared = { nc, js, jsm, kv: null, asks: null, subs: new Set() };
      if (multiplex) {
        // One status watcher per shared connection: a permission error, or the connection ending,
        // fails every subscription riding on it (each then reconnects on its own schedule).
        void nc.closed().then((err) => {
          for (const f of s.subs) f(tag(err || new Error('connection closed')));
        });
        (async () => {
          for await (const st of nc.status()) {
            if (st.type === 'error' && isPermission(st.error) && !isAskPermission(st.error))
              for (const f of s.subs) f(tag(st.error));
          }
        })().catch(() => {});
      }
      return s;
    })();
    const mine = shared;
    try {
      return await mine;
    } catch (e) {
      if (shared === mine) shared = null;
      throw tag(e);
    }
  }
  async function kvOf(s: Shared): Promise<KV> {
    if (!s.kv) s.kv = await new Kvm(s.js).open(BUCKET, { allow_direct: true });
    return s.kv;
  }
  async function close(): Promise<void> {
    const s = shared && (await shared.catch(() => null));
    shared = null;
    if (s && !s.nc.isClosed()) await s.nc.close().catch(() => {});
  }

  /** Publish raw bytes to a subject with a dedupe id; size-checked against the server's max_payload. */
  async function jsPublish(
    s: Shared,
    subject: string,
    data: Uint8Array,
    msgID: string,
    timeoutMs?: number,
  ): Promise<{ seq: number }> {
    const limit = s.nc.info?.max_payload;
    const overhead = 64 + msgID.length; // the dedupe header travels with the payload
    if (limit && data.length + overhead > limit)
      throw new TooLargeError(data.length, limit - overhead);
    try {
      return await s.js.publish(subject, data, { msgID, timeout: timeoutMs || 10000 });
    } catch (e) {
      if (/max_payload|maximum payload/i.test(String(shape(e)?.message)))
        throw new TooLargeError(data.length, limit! - overhead); // the server named its limit
      throw tag(e);
    }
  }

  // ---- publish ----
  async function publish(
    to: string,
    envelope: Envelope,
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<{ id: string }> {
    const subject = subjectFor(to, user);
    const id = String(envelope.id || crypto.randomUUID());
    const s = await conn();
    try {
      await jsPublish(
        s,
        subject,
        new TextEncoder().encode(JSON.stringify(envelope)),
        id,
        timeoutMs,
      );
    } catch (e) {
      // A server provisioned before asks has no stream for them and grants no access to them.
      if (areaOf(to) !== null && (isNoStream(e) || isPermission(e)))
        // eslint-disable-next-line preserve-caught-error -- as below: the message must stand alone
        throw new Error(
          'the server has no stream for asks yet (it was set up before help areas); ask the admin to run mbox-admin.sh init',
        );
      if (
        shape(e)?.name === 'NoRespondersError' ||
        /no responders|jetstream is not enabled/i.test(String(shape(e)?.message))
      ) {
        const who =
          to === 'all' ? 'broadcast' : `user "${parseAddr(to)?.[0] ?? parseService(to)?.user}"`; // `to` is a valid address: subjectFor checked it
        // eslint-disable-next-line preserve-caught-error -- the cause is left off on purpose: explainError() classifies an error by its cause's code, and this message must stand alone
        throw new Error(
          `the server has no mailbox stream for ${who}, so nothing stored the message. Check the address, or ask the admin to run mbox-admin.sh add-user.`,
        );
      }
      throw e;
    }
    return { id };
  }

  // ---- deliveries ----
  /** `area` is the area an ask was read for (its subject names only the area's token). */
  const delivery = (
    { subject, seq, stream, timeMs, data, msgId }: StoredMessage,
    cursor: Cursor,
    area?: string,
  ): Delivery => {
    const ask = area !== undefined ? parseAskSubject(subject) : null;
    const p = ask
      ? { to: areaAddress(area!), sender: ask.sender } // area is set when ask is
      : parseSubject(subject) || { to: subject, sender: null };
    return {
      id: msgId || `${stream}:${seq}`,
      time: Math.floor(timeMs / 1000),
      to: p.to,
      sender: p.sender,
      payload: td.decode(data),
      cursor,
    };
  };

  /** Direct-get a batch of stored messages (no consumer needed). */
  async function directBatch(
    jsm: JetStreamManager,
    stream: string,
    opts: DirectBatchOptions,
  ): Promise<StoredMessage[]> {
    const out: StoredMessage[] = [];
    try {
      const it = await jsm.direct.getBatch(stream, { batch: 256, ...opts });
      for await (const m of it) {
        out.push({
          subject: m.subject,
          seq: m.seq,
          stream,
          timeMs: m.time.getTime(),
          data: m.data,
          msgId: m.header.get('Nats-Msg-Id') || null,
        });
      }
    } catch (e) {
      if (!/message not found|no results/i.test(String(shape(e)?.message))) throw e; // nothing (more) stored
    }
    return out;
  }

  /** Page through direct gets from `start` (a start_time or seq query) until `max` messages or the end. */
  async function directAll(
    jsm: JetStreamManager,
    stream: string,
    start: DirectBatchOptions,
    filter: string,
    max: number,
  ): Promise<StoredMessage[]> {
    const out: StoredMessage[] = [];
    let q = start;
    while (out.length < max) {
      const batch = await directBatch(jsm, stream, { ...q, next_by_subj: filter });
      out.push(...batch.slice(0, max - out.length));
      if (batch.length < 256) break;
      q = { seq: batch[batch.length - 1]!.seq + 1 }; // 256 were read, so the batch is not empty
    }
    return out;
  }

  /**
   * Can this user read asks? One single direct get: a batch get the server refuses is never
   * answered (it looks like a timeout), a single one is refused at once. A server provisioned
   * before asks refuses it (a permission error) or has nothing to answer it (no responders).
   */
  async function probeAsks(jsm: JetStreamManager): Promise<boolean> {
    try {
      await jsm.direct.getMessage(ASK_STREAM, { seq: 1 });
      return true;
    } catch (e) {
      if (isPermission(e) || isNoStream(e)) return false;
      if (/message not found|no message/i.test(String(shape(e)?.message))) return true; // nothing stored yet
      throw tag(e);
    }
  }
  async function asksReadable(): Promise<boolean> {
    const s = await conn();
    if (s.asks === null) s.asks = await probeAsks(s.jsm);
    return s.asks;
  }

  /** The asks stored for `area` from `start` (a start_time or seq query), up to `max`. */
  const asksIn = (
    jsm: JetStreamManager,
    area: string,
    start: DirectBatchOptions,
    max: number,
  ): Promise<StoredMessage[]> =>
    directAll(jsm, ASK_STREAM, start, `${ASK_PREFIX}.${areaToken(area)}.*`, max);

  // ---- now ----
  async function now(): Promise<Cursor> {
    const t = new Date().toISOString();
    try {
      const s = await conn({ timeoutMs: 2000 });
      const own = await s.jsm.streams.info(ownStream);
      const all = await s.jsm.streams.info(ALL_STREAM);
      return { u: own.state.last_seq, a: all.state.last_seq, t };
    } catch {
      return { u: null, a: null, t };
    }
  }

  // ---- subscribe ----
  async function subscribe({
    session,
    addresses,
    cursor,
    signal,
    onOpen,
    onMessage,
    redeliverAfterMs = 60000,
    broadcastPollMs = 30000,
    settleMs = 3000,
    onServiceLost,
  }: SubscribeOptions): Promise<never> {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const name = consumerName(session);
    const areas = [...new Set(addresses.map(areaOf).filter((a): a is string => a !== null))];
    const svcAddrs = [...new Set(addresses.filter(isService))].sort();
    for (const a of svcAddrs)
      if (parseService(a)?.user !== user)
        throw new Error(`service ${a} does not belong to user ${user}`);
    const own = addresses.filter((a) => a !== 'all' && areaOf(a) === null && !isService(a));
    for (const a of own)
      if (parseAddr(a)?.[0] !== user)
        throw new Error(`address ${a} does not belong to user ${user}`);
    const filters = [...new Set(own.map((a) => `${PREFIX}.${a}.*`))].sort();
    const wantAll = addresses.includes('all');
    const ackWait = Math.max(1000, redeliverAfterMs) * NS;
    // The cursor is opaque to the core but ours: it was made by now() or a delivery, and may have
    // been through a file, so each field is read defensively.
    const given = cursor as Partial<NatsCursor> | null | undefined;
    const tokens = new Map(areas.map((a) => [areaToken(a), a]));
    const positions: Record<string, number> = {};
    if (given?.k && typeof given.k === 'object') {
      const kept = Object.entries(given.k).filter(
        ([tok, seq]) => /^[0-9a-f]{32}$/.test(tok) && Number.isSafeInteger(seq) && seq >= 0,
      );
      // Positions of areas no longer offered are kept (offering one again goes on from there),
      // up to a bound; past it, only the offered ones.
      for (const [tok, seq] of kept)
        if (kept.length <= MAX_AREA_POSITIONS || tokens.has(tok)) positions[tok] = seq;
    }
    const cur: NatsCursor = {
      u: given?.u ?? null,
      a: given?.a ?? null,
      k: positions,
      t: given?.t ?? new Date().toISOString(),
    };
    /** A copy of the cursor for a delivery (the core stores it as is). */
    const snapshot = (): NatsCursor => ({ ...cur, k: { ...cur.k } });

    let stopped = false;
    let fail!: (reason: unknown) => void;
    const failed = new Promise<never>((_, rej) => (fail = rej));
    failed.catch(() => {});
    const onAbort = () => {
      stopped = true; // at once: from here on, what onMessage hands back is collected (handBack)
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    // Listen before connecting: an abort while the connection or the consumer is still being set
    // up ends the subscription at once (a listener added after the abort would never fire).
    signal?.addEventListener('abort', onAbort, { once: true });
    /** A setup step that an abort (or a failure) cuts short. */
    const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed]);

    let nc: NatsConnection;
    let mux: Shared | null = null; // the shared connection's record, in multiplex mode
    try {
      if (multiplex) {
        mux = await step(conn());
        nc = mux.nc;
      } else {
        const connecting = connect(connOpts({ pingInterval: 20000, maxPingOut: 2 }));
        try {
          nc = await step(connecting);
        } catch (e) {
          // Left before the connection was up: close it once it is.
          void connecting.then((c) => c.close()).catch(() => {});
          throw e;
        }
      }
    } catch (e) {
      signal?.removeEventListener('abort', onAbort);
      throw tag(e);
    }
    if (mux) {
      mux.subs.add(fail);
      if (nc.isClosed()) fail(new Error('connection closed'));
    } else {
      void nc.closed().then((err) => fail(tag(err || new Error('connection closed'))));
      (async () => {
        for await (const st of nc.status()) {
          if (st.type === 'error' && isPermission(st.error) && !isAskPermission(st.error))
            fail(tag(st.error));
        }
      })().catch(() => {});
    }
    let wakeSub: Subscription | null = null;
    const askSubs: Subscription[] = [];
    // One per durable consumer read: the session's own, and one per claimed service.
    const pullers: Puller[] = [];

    // Deferred acknowledgements still in flight (see the interface: {ackAfter}).
    const pendingAcks = new Set<Promise<unknown>>();
    // Ending: deliveries not acknowledged, handed back together and oldest first (see `finally`).
    const handBack: JsMsg[] = [];
    let handedBack = false;
    const giveBack = (m: JsMsg): void => {
      if (!handedBack) {
        handBack.push(m);
        return;
      }
      try {
        m.nak();
      } catch {
        /* connection gone: redelivered after ack_wait */
      }
    };
    // Serialise every onMessage call (direct + broadcast) through one chain.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = chain.then(fn);
      chain = p.catch(() => {});
      return p;
    };

    try {
      const js = jetstream(nc, { checkAPI: false, timeout: 10000 });
      const jsm = await step(jetstreamManager(nc, { checkAPI: false, timeout: 10000 }));
      /** A durable consumer's info, or null when there is none. */
      const infoOf = async (consumer: string): Promise<ConsumerInfo | null> => {
        try {
          return await step(jsm.consumers.info(ownStream, consumer));
        } catch (e) {
          if (!isNotFound(e)) throw tag(e);
          return null;
        }
      };
      /** Does the claim on `service` name this session? */
      const holds = async (service: string): Promise<boolean> =>
        (await readClaim(jsm, service)).claim?.session === session;

      // Durable consumer: reuse (re-targeting its filter if aliases changed), or (re)create it at
      // the remembered position.
      const info = await infoOf(name);
      if (info) {
        const have = [
          ...(info.config.filter_subjects ||
            (info.config.filter_subject ? [info.config.filter_subject] : [])),
        ].sort();
        if (JSON.stringify(have) !== JSON.stringify(filters) || info.config.ack_wait !== ackWait) {
          await step(
            jsm.consumers.update(ownStream, name, {
              filter_subjects: filters,
              ack_wait: ackWait,
            }),
          );
        }
      } else {
        const start: Partial<ConsumerConfig> =
          cur.u !== null && cur.u !== undefined
            ? { deliver_policy: 'by_start_sequence', opt_start_seq: Number(cur.u) + 1 }
            : { deliver_policy: 'by_start_time', opt_start_time: cur.t };
        await step(
          jsm.consumers.add(ownStream, {
            name,
            durable_name: name,
            description: `mailbox session ${String(session).slice(0, 64)}`,
            filter_subjects: filters,
            ack_policy: 'explicit',
            ack_wait: ackWait,
            max_deliver: -1,
            inactive_threshold: INACTIVE_NS,
            replay_policy: 'instant',
            ...start,
          }),
        );
      }

      // Each claimed service's durable consumer, the service's position whoever holds it. Made on
      // first use to read everything stored for the service (the mail queued while nobody held
      // it), and given no inactivity limit shorter than the stream keeps mail: one recreated while
      // acknowledged mail is still stored would deliver it again. A service this session does not
      // hold (taken over, released, or lapsed) is not read at all.
      const svcPulls: Array<{ service: string; consumer: string; info: ConsumerInfo | null }> = [];
      let maxAgeNs: number | null = null;
      for (const service of svcAddrs) {
        if (!(await step(holds(service)))) {
          onServiceLost?.(service);
          continue;
        }
        const svcName = parseService(service)!.name; // svcAddrs are service addresses
        const consumer = `${SVC_CONSUMER}${svcName}`;
        const sinfo = await infoOf(consumer);
        if (sinfo) {
          if (sinfo.config.ack_wait !== ackWait)
            await step(jsm.consumers.update(ownStream, consumer, { ack_wait: ackWait }));
        } else {
          maxAgeNs ??= (await step(jsm.streams.info(ownStream))).config.max_age ?? 0;
          await step(
            jsm.consumers.add(ownStream, {
              name: consumer,
              durable_name: consumer,
              description: `mailbox service ${service}`,
              filter_subjects: [serviceSubject(user, svcName, '*')],
              ack_policy: 'explicit',
              ack_wait: ackWait,
              max_deliver: -1,
              replay_policy: 'instant',
              deliver_policy: 'all',
              ...(maxAgeNs > 0 ? { inactive_threshold: maxAgeNs } : {}),
            }),
          );
        }
        svcPulls.push({ service, consumer, info: sinfo });
      }
      if (faults.startDelayMs) await step(sleep(faults.startDelayMs)); // test-only: a slow start

      // In-order hand-over between readers, per durable consumer. Messages the previous reader
      // received and never acknowledged (a daemon that handed over, was killed, or lost its
      // connection; for a service, also its previous holder) are still owed: handed back, they
      // return at once (though not always in the order they were handed back); otherwise the
      // server sends them again after ack_wait, and anything newer it sends in the meantime would
      // overtake them. So until every owed message is back (or a deadline a little past ack_wait
      // passes), what arrives is held, and then all of it goes to onMessage in stream order. After
      // that, arrival order is stream order: this subscription is the consumer's only reader and
      // gets new mail in stream order. `service` is set for a service's consumer: each message is
      // offered only while the service's claim names this session.
      const pull = async (
        consumerName: string,
        cinfo: ConsumerInfo | null,
        service: string | null,
      ): Promise<void> => {
        const consumer = await step(js.consumers.get(ownStream, consumerName));
        const owed = cinfo?.num_ack_pending ?? 0;
        const owedUpTo = cinfo?.delivered.stream_seq ?? 0;
        const p: Puller = { messages: null, loop: null, gate: null, released: Promise.resolve() };
        let lost = false;
        pullers.push(p);

        // The service is no longer this session's: read no more of it (stopped first, so that the
        // server does not hand this message straight back), and hand the message back at once, for
        // its holder. Whatever the pull had already received comes through here too.
        const lose = (m: JsMsg): void => {
          if (!lost) {
            lost = true;
            try {
              p.messages?.stop();
            } catch {
              /* already ended */
            }
            onServiceLost?.(service!); // only a service's consumer is ever lost
          }
          try {
            m.nak();
          } catch {
            /* connection gone: redelivered after ack_wait */
          }
        };

        // One message to onMessage (or, ending, back to the server).
        const take = async (m: JsMsg): Promise<void> => {
          // Ending: what the client had already received goes back unseen.
          if (stopped) {
            giveBack(m);
            return;
          }
          if (service !== null) {
            const mine = !lost && (await holds(service));
            if (stopped) return giveBack(m);
            if (!mine) return lose(m);
          }
          // What onMessage resolved to: nothing, or {ackAfter} to defer the acknowledgement.
          const res = (await serial(async () => {
            // The session's position in its own stream; a service's lives in the service's consumer.
            if (service === null) cur.u = m.seq;
            return onMessage(
              delivery(
                {
                  subject: m.subject,
                  seq: m.seq,
                  stream: ownStream,
                  timeMs: Math.floor(m.info.timestampNanos / NS),
                  data: m.data,
                  msgId: m.headers?.get('Nats-Msg-Id') || null,
                },
                snapshot(),
              ),
            );
          })) as { ackAfter?: Promise<unknown> } | null | undefined;
          if (
            res &&
            typeof res === 'object' &&
            res.ackAfter &&
            typeof res.ackAfter.then === 'function'
          ) {
            // Deferred: ack once the caller has delivered it; on rejection hand it back (while
            // running, with a short delay, so this subscription does not get it straight back;
            // while ending, with the rest, in order).
            const settled = res.ackAfter.then(
              () => m.ackAck({ timeout: 5000 }).catch(() => {}),
              () => {
                if (stopped) return giveBack(m);
                try {
                  m.nak(1000);
                } catch {
                  /* connection gone: redelivered after ack_wait */
                }
              },
            );
            pendingAcks.add(settled);
            void settled.finally(() => pendingAcks.delete(settled));
            return;
          }
          await m.ackAck({ timeout: 5000 }).catch(() => {});
        };

        // Everything held, in stream order, ahead of whatever arrives next.
        const openGate = (): void => {
          const gate = p.gate;
          if (!gate) return;
          clearTimeout(gate.timer);
          const ready = [...gate.held.values()].sort((a, b) => a.seq - b.seq);
          p.gate = null;
          p.released = (async () => {
            for (const m of ready) await take(m);
          })();
          p.released.catch((e) => fail(tag(e)));
        };
        if (owed > 0) {
          p.gate = {
            held: new Map(),
            back: new Set(),
            timer: setTimeout(openGate, redeliverAfterMs + Math.max(5000, redeliverAfterMs / 2)),
          };
          p.gate.timer.unref?.();
        }

        const messages = await consumer.consume({
          max_messages: 64,
          abort_on_missing_resource: true,
        });
        p.messages = messages;
        p.loop = (async () => {
          for await (const m of messages) {
            const gate = p.gate;
            if (gate && !stopped) {
              gate.held.set(m.seq, m);
              if (m.seq <= owedUpTo) gate.back.add(m.seq);
              if (gate.back.size >= owed) openGate();
              continue;
            }
            await p.released;
            await take(m);
          }
          if (!lost) throw new Error('message stream ended'); // a lost service just stops
        })();
        p.loop.catch((e) => fail(tag(e)));
      };
      await pull(name, info, null);
      for (const sp of svcPulls) await pull(sp.consumer, sp.info, sp.service);

      // Broadcasts: catch up with direct gets from the remembered sequence; a core subscription on
      // the broadcast subjects is only a wake-up signal (plus a slow poll as a safety net).
      if (wantAll) {
        let running = false;
        let again = false;
        const catchUp = async (retries = 0) => {
          if (running) {
            again = true;
            return;
          }
          running = true;
          try {
            let got = 0;
            for (;;) {
              const q =
                cur.a !== null && cur.a !== undefined
                  ? { seq: Number(cur.a) + 1 }
                  : { start_time: cur.t };
              const batch = await directBatch(jsm, ALL_STREAM, {
                ...q,
                next_by_subj: `${PREFIX}.all.*`,
              });
              for (const m of batch) {
                if (stopped) return; // the saved cursor is the position: nothing to hand back
                await serial(async () => {
                  cur.a = m.seq;
                  await onMessage(delivery(m, snapshot()));
                });
              }
              got += batch.length;
              if (batch.length < 256) break;
            }
            if (!got && retries > 0)
              setTimeout(() => void catchUp(retries - 1).catch(() => {}), 150).unref?.();
          } catch (e) {
            if (!stopped) fail(tag(e));
          } finally {
            running = false;
            if (again && !stopped) {
              again = false;
              void catchUp();
            }
          }
        };
        wakeSub = nc.subscribe(`${PREFIX}.all.*`, { callback: () => void catchUp(3) });
        await step(nc.flush());
        await step(catchUp());
        const iv = setInterval(() => void catchUp(), broadcastPollMs);
        iv.unref?.();
        failed.catch(() => clearInterval(iv));
      }

      // Asks in the offered areas: read like broadcasts, per area, from the remembered sequence (the
      // oldest stored ask for an area the cursor does not know yet). Best effort: a server set up
      // before asks, or a failing read, never ends the subscription; the next wake-up or poll
      // tries again.
      // Anything but a clear refusal (a timeout, say) counts as readable: the reads below are
      // best effort and retried, while a refused batch read would hang until its timeout.
      if (areas.length && (await step(probeAsks(jsm).catch(() => true)))) {
        let running = false;
        let again = false;
        const catchUpAsks = async (retries = 0): Promise<void> => {
          if (running) {
            again = true;
            return;
          }
          running = true;
          try {
            let got = 0;
            for (const [tok, area] of tokens) {
              for (;;) {
                const last = cur.k?.[tok];
                const batch = await asksIn(
                  jsm,
                  area,
                  { seq: last === undefined ? 1 : last + 1 },
                  256,
                );
                for (const m of batch) {
                  if (stopped) return; // the saved cursor is the position: nothing to hand back
                  await serial(async () => {
                    cur.k = { ...cur.k, [tok]: m.seq };
                    await onMessage(delivery(m, snapshot(), area));
                  });
                }
                got += batch.length;
                if (batch.length < 256) break;
              }
            }
            if (!got && retries > 0)
              setTimeout(() => void catchUpAsks(retries - 1).catch(() => {}), 150).unref?.();
          } catch {
            /* best effort: tried again on the next wake-up or poll */
          } finally {
            running = false;
            if (again && !stopped) {
              again = false;
              void catchUpAsks();
            }
          }
        };
        for (const tok of tokens.keys())
          askSubs.push(
            nc.subscribe(`${ASK_PREFIX}.${tok}.*`, { callback: () => void catchUpAsks(3) }),
          );
        await step(nc.flush());
        await step(catchUpAsks());
        const iv = setInterval(() => void catchUpAsks(), broadcastPollMs);
        iv.unref?.();
        failed.catch(() => clearInterval(iv));
      }

      await onOpen?.();
      await failed;
      throw new Error('unreachable');
    } catch (e) {
      throw tag(e);
    } finally {
      stopped = true;
      signal?.removeEventListener('abort', onAbort);
      fail(new Error('closed'));
      // Mail still held for the owed messages was never offered: it goes back with the rest.
      for (const p of pullers) {
        if (!p.gate) continue;
        clearTimeout(p.gate.timer);
        handBack.push(...p.gate.held.values());
        p.gate = null;
      }
      // 1. Take nothing new. What the client already holds still runs through each puller's loop,
      //    which collects it for handing back; the loop ends after it.
      for (const p of pullers)
        try {
          p.messages?.stop();
        } catch {
          /* already ended */
        }
      for (const sub of [wakeSub, ...askSubs])
        try {
          sub?.unsubscribe();
        } catch {
          /* already ended */
        }
      if (!nc.isClosed()) {
        // 2. Let the deliveries already handed out settle: acknowledged, or handed back.
        const settle = new Promise((r) => setTimeout(r, settleMs).unref?.());
        await Promise.race([
          Promise.all(
            pullers.flatMap((p) => [
              (p.loop ?? Promise.resolve()).catch(() => {}),
              p.released.catch(() => {}),
            ]),
          ),
          settle,
        ]);
        if (pendingAcks.size) await Promise.race([Promise.allSettled([...pendingAcks]), settle]);
        // 3. Hand back the rest at once, oldest first, and make sure the server has it before the
        //    caller lets the session's next subscriber in.
        if (faults.handBackDelayMs) await sleep(faults.handBackDelayMs); // test-only: a late hand-back
        handedBack = true;
        handBack.sort((a, b) => a.seq - b.seq);
        if (faults.loseHandBack) handBack.splice(-faults.loseHandBack); // test-only: the stop gap
        for (const m of handBack) {
          try {
            m.nak();
          } catch {
            /* connection gone: redelivered after ack_wait */
          }
        }
        if (handBack.length)
          await Promise.race([
            nc.flush().catch(() => {}),
            new Promise((r) => setTimeout(r, 5000).unref?.()),
          ]);
      }
      if (mux)
        mux.subs.delete(fail); // shared connection: this subscription's pieces are ended
      else if (!nc.isClosed()) await nc.close().catch(() => {});
    }
  }

  // ---- poll ----
  async function poll(
    addresses: string[],
    { lookbackMs, max = 256 }: PollOptions,
  ): Promise<Delivery[]> {
    const s = await conn();
    const start_time = new Date(Date.now() - lookbackMs).toISOString();
    const out: Array<{ m: StoredMessage; area?: string }> = [];
    for (const a of [...new Set(addresses)]) {
      const area = areaOf(a);
      try {
        if (area !== null) {
          // Asks: none on a server set up before them (that is not an error here).
          if (await asksReadable())
            for (const m of await asksIn(s.jsm, area, { start_time }, max)) out.push({ m, area });
        } else if (a === 'all')
          for (const m of await directAll(
            s.jsm,
            ALL_STREAM,
            { start_time },
            `${PREFIX}.all.*`,
            max,
          ))
            out.push({ m });
        else {
          const svc = parseService(a);
          if (svc && svc.user !== user) continue; // another user's service: not in our stream
          for (const m of await directAll(
            s.jsm,
            ownStream,
            { start_time },
            svc ? serviceSubject(user, svc.name, '*') : `${PREFIX}.${a}.*`,
            max,
          ))
            out.push({ m });
        }
      } catch (e) {
        throw tag(e);
      }
    }
    out.sort((x, y) => x.m.timeMs - y.m.timeMs);
    return out.map(({ m, area }) => delivery(m, null, area));
  }

  // ---- presence (KV bucket with a TTL) ----
  const keyOf = (rec: PresenceRecord): string => {
    const host = parseAddr(rec.address)?.[1];
    if (!host) throw new Error(`invalid address ${rec.address}`);
    return presenceKey(user, host, rec.session);
  };
  const put = async (rec: PresenceRecord, { timeoutMs }: PresenceOptions = {}): Promise<void> => {
    const s = await conn({ timeoutMs });
    const kv = await kvOf(s);
    try {
      await kv.put(keyOf(rec), JSON.stringify({ ...rec, at: new Date().toISOString() }));
    } catch (e) {
      throw tag(e);
    }
  };
  const presence: Presence = {
    announce: put,
    heartbeat: put,
    async depart(rec, { timeoutMs } = {}) {
      const s = await conn({ timeoutMs });
      const kv = await kvOf(s);
      await kv.delete(keyOf(rec)).catch((e) => {
        throw tag(e);
      });
    },
    async update(rec, opts) {
      const s = await conn(opts);
      const kv = await kvOf(s);
      const e = await kv.get(keyOf(rec)).catch((err) => {
        throw tag(err);
      });
      if (e && e.operation === 'PUT') await put(rec, opts);
    },
    async list() {
      const s = await conn();
      const peers: PresenceEntry[] = [];
      let it: Awaited<ReturnType<JetStreamManager['direct']['getLastMessagesFor']>>;
      try {
        it = await s.jsm.direct.getLastMessagesFor(BUCKET_STREAM, {
          multi_last: [`$KV.${BUCKET}.>`],
        });
      } catch (e) {
        throw tag(e);
      }
      for await (const m of it) {
        const op = m.header.get('KV-Operation');
        if (op === 'DEL' || op === 'PURGE') continue;
        const key = m.subject.slice(`$KV.${BUCKET}.`.length);
        const keyUser = key.split('.')[0] ?? '';
        let j: UntrustedPresence | null;
        try {
          // Any user can write any bytes under their own key: untrusted until checked below.
          j = JSON.parse(td.decode(m.data)) as UntrustedPresence | null;
        } catch {
          continue;
        }
        const addr = parseAddr(j?.address);
        if (!addr || !j || addr[0] !== keyUser) continue; // only the verified writer's own addresses (addr implies j)
        peers.push({
          session: typeof j.session === 'string' ? j.session : key,
          address: j.address as string, // parseAddr accepted it, so it is a string
          aliases: Array.isArray(j.aliases)
            ? (j.aliases as unknown[]).filter((a): a is string => parseAddr(a)?.[0] === keyUser)
            : [],
          agent: typeof j.agent === 'string' ? j.agent : null,
          user: keyUser,
          host: addr[1],
          cwd: typeof j.cwd === 'string' ? j.cwd : null,
          pid: (j.pid ?? null) as number | null, // as announced; not validated
          // Self-asserted metadata, kept only when it has the right shape (display only).
          repo: checkRepo(j.repo),
          branch: checkBranch(j.branch),
          role: checkRole(j.role),
          parent: checkParent(j.parent),
          status: checkStatus(j.status),
          offers: checkOffers(j.offers),
          lastSeen: m.time.getTime(),
          live: true,
        });
      }
      peers.sort((a, b) => b.lastSeen - a.lastSeen);
      return peers;
    },
  };

  // ---- service addresses (claims in the presence bucket) ----
  const services: Services = {
    async read(service) {
      const s = await conn();
      return readClaim(s.jsm, service);
    },
    async write(claim, version) {
      if (parseService(claim.service)?.user !== user)
        throw new Error(`service ${claim.service} does not belong to user ${user}`);
      const s = await conn();
      const kv = await kvOf(s);
      try {
        await kv.put(claimKey(claim.service), JSON.stringify(claim), { previousSeq: version });
        return true;
      } catch (e) {
        if (isWrongLastSeq(e)) return false;
        throw tag(e);
      }
    },
    async remove(service, version) {
      if (parseService(service)?.user !== user)
        throw new Error(`service ${service} does not belong to user ${user}`);
      const s = await conn();
      const kv = await kvOf(s);
      try {
        // A delete marker, never a purge: the bucket refuses rollups.
        await kv.delete(claimKey(service), { previousSeq: version });
        return true;
      } catch (e) {
        if (isWrongLastSeq(e)) return false;
        throw tag(e);
      }
    },
    async list() {
      const s = await conn();
      const out: ServiceClaim[] = [];
      let it: Awaited<ReturnType<JetStreamManager['direct']['getLastMessagesFor']>>;
      try {
        it = await s.jsm.direct.getLastMessagesFor(BUCKET_STREAM, {
          multi_last: [`$KV.${BUCKET}.*.${SVC}.*`],
        });
        for await (const m of it) {
          const op = m.header.get('KV-Operation');
          if (op === 'DEL' || op === 'PURGE') continue;
          const c = checkClaim(m.subject.slice(`$KV.${BUCKET}.`.length), m.data, m.time.getTime());
          if (c) out.push(c);
        }
      } catch (e) {
        if (/no results|not found/i.test(String(shape(e)?.message))) return out; // no claims at all
        throw tag(e);
      }
      return out.sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
    },
  };

  // ---- events feed ----
  const ownEvents = eventsStreamFor(user);
  /** An error saying `target`'s feed is not readable here (the server refused it). */
  const notShared = (target: string, cause: unknown): Error =>
    Object.assign(
      new Error(
        `${target}'s events feed is not shared with you (it is private, or there is no such user)`,
        { cause },
      ),
      { notShared: true },
    );
  const events: Events = {
    async publish(ev, { timeoutMs } = {}) {
      const host = parseAddr(ev.address)?.[1];
      if (!host || parseAddr(ev.address)?.[0] !== user)
        throw new Error(`event address ${ev.address} does not belong to user ${user}`);
      const s = await conn({ timeoutMs });
      try {
        await jsPublish(
          s,
          `${EVT_PREFIX}.${user}.${host}`,
          new TextEncoder().encode(JSON.stringify(ev)),
          crypto.randomUUID(),
          timeoutMs,
        );
      } catch (e) {
        // A server provisioned before events feeds has no stream for it and grants no access to it.
        if (isNoStream(e) || isPermission(e))
          // eslint-disable-next-line preserve-caught-error -- as in publish(): the message must stand alone
          throw new Error(
            `the server has no events feed for user "${user}"; ask the admin to run mbox-admin.sh init`,
          );
        throw e;
      }
    },
    async read(target, { sinceMs, max = 10000 }) {
      if (!SEG_RE.test(target)) throw new Error(`invalid user name "${target}"`);
      const s = await conn();
      const start_time = new Date(Date.now() - sinceMs).toISOString();
      let stored: StoredMessage[];
      try {
        // A batch get the server refuses is never answered (it looks like a timeout, after the
        // full request timeout); a single get is refused at once. So probe the feed first (another
        // user's, or the own one on a server provisioned before feeds), with one get that any
        // outcome but a refusal shows is allowed.
        await s.jsm.direct.getMessage(eventsStreamFor(target), { seq: 1 }).catch((e) => {
          if (isPermission(e) || isNoStream(e)) throw e;
        });
        stored = await directAll(
          s.jsm,
          eventsStreamFor(target),
          { start_time },
          `${EVT_PREFIX}.${target}.*`,
          max,
        );
      } catch (e) {
        if (target !== user && (isPermission(e) || isNoStream(e))) throw notShared(target, e);
        if (target === user && (isNoStream(e) || isPermission(e)))
          // eslint-disable-next-line preserve-caught-error -- as in publish(): the message must stand alone
          throw new Error(
            'the server has no events feed for you yet; ask the admin to run mbox-admin.sh init',
          );
        throw tag(e);
      }
      const out: FeedEntry[] = [];
      for (const m of stored) {
        // The stream holds only evt.<target>.*, which only <target> may publish: the verified owner.
        const t = m.subject.split('.');
        if (t.length !== 3 || t[0] !== EVT_PREFIX || t[1] !== target) continue;
        const ev = checkEvent(td.decode(m.data), target, m.timeMs);
        if (ev) out.push(ev);
      }
      return out;
    },
    async shared() {
      const s = await conn();
      let m: Awaited<ReturnType<JetStreamManager['direct']['getMessage']>>;
      try {
        m = await s.jsm.direct.getMessage(SHARING_STREAM, {
          last_by_subj: `$KV.${SHARING_BUCKET}.${SHARING_KEY}`,
        });
      } catch (e) {
        if (isNoStream(e)) return null;
        throw tag(e);
      }
      if (!m) return null;
      const op = m.header.get('KV-Operation');
      if (op === 'DEL' || op === 'PURGE') return null;
      try {
        // Written by the admin, but checked like anything read from the wire.
        const j = JSON.parse(td.decode(m.data)) as unknown;
        if (!Array.isArray(j)) return null;
        return [...new Set(j.filter((u): u is string => typeof u === 'string' && SEG_RE.test(u)))];
      } catch {
        return null;
      }
    },
  };

  // ---- diagnose ----
  async function diagnose({ host }: { user: string; host: string }): Promise<DiagnoseCheck[]> {
    const checks: DiagnoseCheck[] = [];
    const add = (ok: boolean, name: string, hint?: string): number =>
      checks.push({ ok, name, hint });
    let s;
    try {
      s = await conn({ timeoutMs: 5000 });
      add(true, `connected and authenticated as ${user} (${s.nc.getServer()})`);
    } catch (e) {
      add(false, 'connect and authenticate', explainError(e));
      return checks;
    }
    try {
      await s.jsm.getAccountInfo();
      add(true, 'JetStream is enabled for this account');
    } catch (e) {
      add(false, 'JetStream account info', explainError(e));
    }
    try {
      await s.jsm.streams.info(ownStream);
      add(true, `own mailbox stream ${ownStream} is accessible`);
    } catch (e) {
      add(
        false,
        `own mailbox stream ${ownStream}`,
        `${explainError(e)} (the admin creates it with mbox-admin.sh add-user)`,
      );
    }
    try {
      const subject = `${PREFIX}.${user}.${host}.${DOCTOR_LABEL}.${user}`;
      const id = `doctor-${crypto.randomUUID()}`;
      const ack = await jsPublish(
        s,
        subject,
        new TextEncoder().encode(`doctor ${new Date().toISOString()}`),
        id,
      );
      const back = await s.jsm.direct.getMessage(ownStream, { seq: ack.seq });
      if (back && back.header.get('Nats-Msg-Id') === id)
        add(true, 'test message to self published and read back');
      else add(false, 'test message to self', 'published but could not read it back');
    } catch (e) {
      add(false, 'test message to self', explainError(e));
    }
    try {
      await directBatch(s.jsm, ALL_STREAM, { seq: 1, batch: 1, next_by_subj: `${PREFIX}.all.*` });
      add(true, 'broadcast stream is readable');
    } catch (e) {
      add(false, 'broadcast stream', explainError(e));
    }
    try {
      const kv = await kvOf(s);
      const key = `${user}.${host}.doctor`;
      await kv.put(key, '{}');
      await kv.get(key);
      await kv.delete(key);
      await presence.list();
      add(true, 'presence registry: write own entry, read all');
    } catch (e) {
      add(false, 'presence registry', explainError(e));
    }
    try {
      // A single get: a refused batch get is never answered (see events.read).
      await s.jsm.direct.getMessage(ownEvents, { seq: 1 });
      add(true, `own events feed ${ownEvents} is readable`);
    } catch (e) {
      add(
        false,
        `own events feed ${ownEvents}`,
        isNoStream(e) || isPermission(e)
          ? 'the server has no events feed for you yet; ask the admin to run mbox-admin.sh init'
          : explainError(e),
      );
    }
    try {
      const team = await events.shared();
      if (team === null)
        add(
          false,
          'events feed sharing',
          'the server has no sharing list; ask the admin to run mbox-admin.sh init',
        );
      else if (team.includes(user))
        add(true, 'events feed sharing: team (every mailbox user can read your feed)');
      else add(true, 'events feed sharing: private (only you can read your feed)');
    } catch (e) {
      add(false, 'events feed sharing', explainError(e));
    }
    try {
      if (await asksReadable()) add(true, 'asks (help areas) are readable');
      else
        add(
          false,
          'asks (help areas)',
          'the server has no stream for asks yet; ask the admin to run mbox-admin.sh init',
        );
    } catch (e) {
      add(false, 'asks (help areas)', explainError(e));
    }
    const other = `not-${user}`.slice(0, 40);
    try {
      await s.jsm.streams.info(streamFor(other));
      add(
        false,
        "isolation: could query another user's mailbox stream",
        'your account has broader permissions than a mailbox user should; ask the admin to check users.conf',
      );
    } catch (e) {
      if (isPermission(e))
        add(
          true,
          "isolation: another user's mailbox is not readable (permission denied, as expected)",
        );
      else add(false, 'isolation check', `expected a permission error, got: ${explainError(e)}`);
    }
    return checks;
  }

  return {
    publish,
    subscribe,
    poll,
    now,
    presence,
    events,
    services,
    asksReadable,
    limits: { maxLabelLen },
    explainError,
    diagnose,
    close,
  };
}
