// Broker transport backed by a NATS server with JetStream (https://docs.nats.io). This is the ONLY
// file that knows about NATS: subjects, streams, consumers, the KV bucket, acks and permission
// errors. Core code (everything outside src/core/transport/) talks to the interface below.
//
// ---- Transport interface (what core may rely on) ----------------------------------------------
//
// Addresses are the core's `<user>.<host>.<label>` strings, plus the broadcast pseudo-address 'all'.
//
//   publish(to, envelope, {timeoutMs}) -> {id}
//       Deliver `envelope` (a JSON-able object with a unique `.id`) to one address or 'all'. The
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
//       acknowledged at once and oldest first, so the session's next subscriber (a new delivery
//       daemon after a handover) gets it in order, before anything newer. One gap remains: a
//       delivery the server sends in the instant the subscription ends is seen by nobody and
//       comes back after redeliverAfterMs. Broadcasts have no server-side acknowledgement: the
//       caller's saved cursor is their position. onOpen() is called each time the subscription is
//       (re)established. The promise never resolves: it rejects when the connection ends, or
//       with an AbortError when `signal` aborts. Errors with `.authProblem === true` mean
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
//   limits.maxLabelLen(user, host)   longest label that still forms a routable address
//   explainError(err) -> string      human-readable message for any error thrown above
//   diagnose({user, host}) -> [{ok, name, hint?}]       connectivity / auth / permission self-check
//   close()                          release connections (call before exiting)
//
// createTransport(cfg, {multiplex}): with multiplex: true (a long-running process serving many
// sessions), every subscribe() and every request-style call share ONE connection; ending a
// subscription leaves it open, and close() releases it. Without it, each subscribe() has its own.
//
// delivery = {id, time(unix s), to ('all' | address), sender (server-verified user), payload
//             (string as published), cursor}
// -------------------------------------------------------------------------------------------------
//
// NATS mapping
//   direct mail   mbx.<toUser>.<toHost>.<toLabel>.<fromUser>   stream MBX_<TOUSER> (mbx.<user>.>)
//   broadcast     mbx.all.<fromUser>                           stream MBX_ALL      (mbx.all.*)
//   presence      KV bucket `presence`, key <user>.<host>.<session hash>
// The trailing <fromUser> token is enforced by the server's publish permissions, so it is the
// verified sender. Each session reads its own stream through one durable pull consumer named after
// the session (filter = this session's addresses, explicit ack); broadcasts are read with direct
// gets from a locally remembered sequence (no consumer on the shared stream, so nobody needs
// consumer rights there). Request replies use a per-user inbox prefix _INBOX_<user>.
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
import type {
  Cursor,
  Delivery,
  DiagnoseCheck,
  Envelope,
  PollOptions,
  Presence,
  PresenceEntry,
  PresenceOptions,
  PresenceRecord,
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

export function subjectFor(to: string, fromUser: string): string {
  if (!SEG_RE.test(fromUser || '')) throw new Error(`invalid sender user "${fromUser}"`);
  if (to === 'all') return `${PREFIX}.all.${fromUser}`;
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
  if (t.length === 5 && t.slice(1).every((x) => SEG_RE.test(x)))
    return { to: t.slice(1, 4).join('.'), sender: t[4]! }; // length is 5
  return null;
}

/** Durable consumer name for a session id (consumer names may not contain '.', '*', '>' or spaces). */
export function consumerName(sid: string): string {
  const s = String(sid);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s;
  return `s-${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
}

const sessionShort = (sid: string): string =>
  crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 12);
export const presenceKey = (user: string, host: string, sid: string): string =>
  `${user}.${host}.${sessionShort(sid)}`;

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
}

/** The position of a receiver: last sequence read from the own stream and from the broadcast stream. */
interface NatsCursor {
  u: number | null;
  a: number | null;
  /** Where to start when there is no sequence yet (ISO-8601). */
  t: string;
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
  /** In multiplex mode: the failure callbacks of the subscriptions riding on this connection. */
  subs: Set<(reason: unknown) => void>;
}

export function createTransport(
  cfg: TransportConfig,
  { multiplex = false }: TransportOptions = {},
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
      const s: Shared = { nc, js, jsm, kv: null, subs: new Set() };
      if (multiplex) {
        // One status watcher per shared connection: a permission error, or the connection ending,
        // fails every subscription riding on it (each then reconnects on its own schedule).
        void nc.closed().then((err) => {
          for (const f of s.subs) f(tag(err || new Error('connection closed')));
        });
        (async () => {
          for await (const st of nc.status()) {
            if (st.type === 'error' && isPermission(st.error))
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
      if (
        shape(e)?.name === 'NoRespondersError' ||
        /no responders|jetstream is not enabled/i.test(String(shape(e)?.message))
      ) {
        const who = to === 'all' ? 'broadcast' : `user "${parseAddr(to)?.[0]}"`; // `to` is a valid address: subjectFor checked it
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
  const delivery = (
    { subject, seq, stream, timeMs, data, msgId }: StoredMessage,
    cursor: Cursor,
  ): Delivery => {
    const p = parseSubject(subject) || { to: subject, sender: null };
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
  }: SubscribeOptions): Promise<never> {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const name = consumerName(session);
    const own = addresses.filter((a) => a !== 'all');
    for (const a of own)
      if (parseAddr(a)?.[0] !== user)
        throw new Error(`address ${a} does not belong to user ${user}`);
    const filters = [...new Set(own.map((a) => `${PREFIX}.${a}.*`))].sort();
    const wantAll = addresses.includes('all');
    const ackWait = Math.max(1000, redeliverAfterMs) * NS;
    // The cursor is opaque to the core but ours: it was made by now() or a delivery, and may have
    // been through a file, so each field is read defensively.
    const given = cursor as Partial<NatsCursor> | null | undefined;
    const cur: NatsCursor = {
      u: given?.u ?? null,
      a: given?.a ?? null,
      t: given?.t ?? new Date().toISOString(),
    };

    let nc: NatsConnection;
    let mux: Shared | null = null; // the shared connection's record, in multiplex mode
    try {
      if (multiplex) {
        mux = await conn();
        nc = mux.nc;
      } else {
        nc = await connect(connOpts({ pingInterval: 20000, maxPingOut: 2 }));
      }
    } catch (e) {
      throw tag(e);
    }
    let stopped = false;
    let fail!: (reason: unknown) => void;
    const failed = new Promise<never>((_, rej) => (fail = rej));
    failed.catch(() => {});
    const onAbort = () => {
      stopped = true; // at once: from here on, what onMessage hands back is collected (handBack)
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (mux) {
      mux.subs.add(fail);
      if (nc.isClosed()) fail(new Error('connection closed'));
    } else {
      void nc.closed().then((err) => fail(tag(err || new Error('connection closed'))));
      (async () => {
        for await (const st of nc.status()) {
          if (st.type === 'error' && isPermission(st.error)) fail(tag(st.error));
        }
      })().catch(() => {});
    }
    let messages: ConsumerMessages | null = null;
    let wakeSub: Subscription | null = null;
    let directLoop: Promise<never> | null = null;

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
      const jsm = await jetstreamManager(nc, { checkAPI: false, timeout: 10000 });

      // Durable consumer: reuse (re-targeting its filter if aliases changed), or (re)create it at
      // the remembered position.
      let info: ConsumerInfo | null = null;
      try {
        info = await jsm.consumers.info(ownStream, name);
      } catch (e) {
        if (!isNotFound(e)) throw tag(e);
      }
      if (info) {
        const have = [
          ...(info.config.filter_subjects ||
            (info.config.filter_subject ? [info.config.filter_subject] : [])),
        ].sort();
        if (JSON.stringify(have) !== JSON.stringify(filters) || info.config.ack_wait !== ackWait) {
          await jsm.consumers.update(ownStream, name, {
            filter_subjects: filters,
            ack_wait: ackWait,
          });
        }
      } else {
        const start: Partial<ConsumerConfig> =
          cur.u !== null && cur.u !== undefined
            ? { deliver_policy: 'by_start_sequence', opt_start_seq: Number(cur.u) + 1 }
            : { deliver_policy: 'by_start_time', opt_start_time: cur.t };
        await jsm.consumers.add(ownStream, {
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
        });
      }
      const consumer = await js.consumers.get(ownStream, name);
      messages = await consumer.consume({ max_messages: 64, abort_on_missing_resource: true });

      directLoop = (async () => {
        for await (const m of messages) {
          // Ending: what the client had already received goes back unseen.
          if (stopped) {
            giveBack(m);
            continue;
          }
          // What onMessage resolved to: nothing, or {ackAfter} to defer the acknowledgement.
          const res = (await serial(async () => {
            cur.u = m.seq;
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
                { ...cur },
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
            continue;
          }
          await m.ackAck({ timeout: 5000 }).catch(() => {});
        }
        throw new Error('message stream ended');
      })();
      directLoop.catch((e) => fail(tag(e)));

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
                  await onMessage(delivery(m, { ...cur }));
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
        await nc.flush();
        await catchUp();
        const iv = setInterval(() => void catchUp(), broadcastPollMs);
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
      // 1. Take nothing new. What the client already holds still runs through directLoop, which
      //    collects it for handing back; the loop ends after it.
      try {
        messages?.stop();
      } catch {
        /* already ended */
      }
      try {
        wakeSub?.unsubscribe();
      } catch {
        /* already ended */
      }
      if (!nc.isClosed()) {
        // 2. Let the deliveries already handed out settle: acknowledged, or handed back.
        const settle = new Promise((r) => setTimeout(r, settleMs).unref?.());
        await Promise.race([directLoop ? directLoop.catch(() => {}) : null, settle]);
        if (pendingAcks.size) await Promise.race([Promise.allSettled([...pendingAcks]), settle]);
        // 3. Hand back the rest at once, oldest first, and make sure the server has it before the
        //    caller lets the session's next subscriber in.
        handedBack = true;
        for (const m of handBack.sort((a, b) => a.seq - b.seq)) {
          try {
            m.nak();
          } catch {
            /* connection gone: redelivered after ack_wait */
          }
        }
        if (handBack.length) await nc.flush().catch(() => {});
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
    const out: StoredMessage[] = [];
    for (const a of [...new Set(addresses)]) {
      try {
        if (a === 'all')
          out.push(...(await directAll(s.jsm, ALL_STREAM, { start_time }, `${PREFIX}.all.*`, max)));
        else
          out.push(...(await directAll(s.jsm, ownStream, { start_time }, `${PREFIX}.${a}.*`, max)));
      } catch (e) {
        throw tag(e);
      }
    }
    out.sort((x, y) => x.timeMs - y.timeMs);
    return out.map((m) => delivery(m, null));
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
          lastSeen: m.time.getTime(),
          live: true,
        });
      }
      peers.sort((a, b) => b.lastSeen - a.lastSeen);
      return peers;
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
    limits: { maxLabelLen },
    explainError,
    diagnose,
    close,
  };
}
