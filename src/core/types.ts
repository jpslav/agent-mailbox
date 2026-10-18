// The shared contracts of the mailbox core: config, the envelope v1 wire format, deliveries and
// parsed messages, session state, registrations, presence entries and the transport seam.
//
// Nothing here names a broker. The only module that does is src/core/transport/nats.ts (the
// transport seam rule, enforced by test/transport.test.ts), and the wire formats are pinned
// byte for byte by test/golden.test.ts.

/** A process environment (what `process.env` is). */
export type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------- config

/** The client configuration after the file and the environment overrides are merged. */
export interface Config {
  servers: string[];
  user: string;
  password: string;
  /** Largest envelope `mbox send` accepts, in bytes; null = only the server's limit applies. */
  maxBytes: number | null;
}

// ---------------------------------------------------------------- wire formats

/**
 * Envelope v1, the JSON payload of every message. `id` is broker-independent: it is what `--re`
 * references and what dedupes. The field names and their order are the wire format.
 */
export interface Envelope {
  v: 1;
  id: string;
  /** The sender's session address (self-asserted; the verified part is the user). */
  from: string;
  /**
   * The recipient: a session address, a service address `<user>.<name>`, 'all' for a broadcast or
   * `area:<area>` for an ask.
   */
  to: string;
  agent: string;
  subject: string | null;
  body: string;
  inReplyTo: string | null;
  /** ISO-8601 timestamp. */
  sentAt: string;
}

/**
 * The opaque position of a receiver in the transport. The core stores it and hands it back; only
 * the transport knows its shape.
 */
export type Cursor = unknown;

/**
 * One message as the transport hands it over. `payload` is the text as published (usually an
 * envelope, but anyone can publish anything); `sender` is the user the broker verified.
 */
export interface Delivery {
  id: string;
  /** Unix seconds. */
  time: number;
  /**
   * 'all', the recipient session address, a service address `<user>.<name>`, or an area's
   * pseudo-address `area:<area>` (an ask). Always where the transport read it, never the envelope's
   * claim.
   */
  to: string;
  sender: string | null;
  payload: string;
  cursor: Cursor;
}

/** A delivery normalised by `parseDelivery`: an envelope, or a raw message when it was not one. */
export interface Message {
  id: string;
  time: number;
  sender: string | null;
  from: string;
  to: string;
  agent: string | null;
  subject: string | null;
  body: string;
  inReplyTo: string | null;
  sentAt: string | null;
  /** True when the payload was not an envelope v1. */
  raw: boolean;
}

// ---------------------------------------------------------------- session state

/** `<state>/sessions/<sid>.json`: a session's identity. */
export interface SessionState {
  address: string;
  aliases: string[];
  cwd: string;
  createdAt: string;
  /** Self-asserted, display only (see session-meta.ts); absent until set. */
  role?: Role | null;
  /** The address of the session that spawned this one: self-asserted, display only. */
  parent?: string | null;
  /** One line about what the session is doing (`mbox status`). */
  status?: string | null;
  /** The help areas this session offers (`mbox offer`), sorted; absent until set. */
  offers?: string[];
  /**
   * The service addresses (`<user>.<name>`) this session has claimed (`mbox name --service`),
   * sorted; absent until set. The claims on the server decide who holds them; this is what the
   * session's receivers read and keep claimed.
   */
  services?: string[];
  /**
   * The address the session had before it was given this one because the mailbox user changed
   * (see ensureSession). A cursor written without an address predates that change.
   */
  previousAddress?: string;
}

/** A session's self-described role: display only, never authority. */
export type Role = 'manager' | 'worker';

/** `<state>/sessions/<sid>.cursor.json`: where the session's receiver is, and what it has shown. */
export interface CursorFile {
  cursor: Cursor;
  /** Recently shown message ids -> delivery time (a bounded ring, newest last). */
  seen: Record<string, number>;
  /** The address the cursor was made for (absent in files from before 0.5.7). */
  address?: string;
}

// ---------------------------------------------------------------- registrations

/**
 * Where an agent session can be reached for push delivery. `kind` names the protocol (an
 * adapter's `delivery.kind`); the other fields belong to that adapter (Claude Code: `path`,
 * `token`). It may hold a secret.
 */
export interface Endpoint {
  kind: string;
  [field: string]: unknown;
}

/** What a session-start hook registers. */
export interface RegistrationInput {
  sid: string;
  address: string;
  endpoint: Endpoint;
  hostPid?: number | null;
  cwd?: string | null;
  agent: string;
}

/** `<state>/registrations/<sid>.json`: a session registered for push delivery (mode 0600). */
export interface Registration {
  sid: string;
  address: string;
  endpoint: Endpoint;
  hostPid: number | null;
  cwd: string | null;
  agent: string;
  /** ISO-8601; written by `register`. */
  registeredAt?: string;
}

// ---------------------------------------------------------------- push delivery

/** What the delivery daemon tells an adapter about the batch it is delivering. */
export interface DeliveryMeta {
  sid: string;
  /** The session's address. */
  address: string;
  /** How many messages the text carries. */
  count: number;
  ids: string[];
  /** The distinct `from` addresses of those messages. */
  senders: string[];
}

/**
 * An adapter's way of pushing mail into a running session (`mbox deliverd` uses it): the
 * session-start hook saves `endpointFromHook` in the session's registration, the daemon calls
 * `deliver` with it.
 */
export interface DeliveryCapability {
  /** The endpoint kind this adapter delivers to. */
  kind: string;
  /** Environment variables that name one session; the shared daemon must not inherit them. */
  sessionEnv: readonly string[];
  /** The endpoint the hook can see (hook payload and environment), or null when there is none. */
  endpointFromHook(input: unknown, env: Env): Endpoint | null;
  /** Resolves once the agent has the text; throws if it could not be delivered. */
  deliver(endpoint: Endpoint, text: string, meta: DeliveryMeta): Promise<void>;
}

// ---------------------------------------------------------------- presence

/** What a session announces about itself. */
export interface PresenceRecord {
  address: string;
  aliases: string[];
  session: string;
  agent: string;
  user: string;
  host: string | null;
  cwd: string | null;
  pid: number;
  /** `owner/name` from the git remote of `cwd`, refreshed on every heartbeat; null outside git. */
  repo: string | null;
  /** The checked-out branch of `cwd`; null outside git or on a detached HEAD. */
  branch: string | null;
  role: Role | null;
  parent: string | null;
  status: string | null;
  /** The help areas the session offers (`mbox offer`), sorted. */
  offers: string[];
}

/** A live session as `presence.list()` reports it. */
export interface PresenceEntry {
  session: string;
  address: string;
  aliases: string[];
  agent: string | null;
  /** The server-verified writer of the entry. */
  user: string;
  host: string;
  cwd: string | null;
  /** As announced; not validated. */
  pid: number | null;
  /** The fields below are self-asserted by the writer and checked for shape only. */
  repo: string | null;
  branch: string | null;
  role: Role | null;
  /** A valid address, but not necessarily a live one. */
  parent: string | null;
  status: string | null;
  /** Well-formed areas only, sorted, at most MAX_OFFERS (areas.ts). */
  offers: string[];
  /** When the entry was last refreshed (ms since the epoch). */
  lastSeen: number;
  live: true;
}

// ---------------------------------------------------------------- events feed

/** What happened to a session. `done` is the session saying it finished (`mbox done`). */
export type EventKind =
  'started' | 'ended' | 'status-changed' | 'role-changed' | 'parent-changed' | 'done';

/**
 * One entry in a user's events feed: a session's lifecycle and metadata, never message contents.
 * The field names and their order are the wire format (test/golden-events.test.ts).
 */
export interface SessionEvent {
  event: EventKind;
  address: string;
  user: string;
  host: string | null;
  repo: string | null;
  branch: string | null;
  role: Role | null;
  parent: string | null;
  status: string | null;
  /** ISO-8601, as the writer stamped it. */
  at: string;
}

/** An event as `events.read` returns it: checked for shape, with server-verified user and time. */
export interface FeedEntry extends SessionEvent {
  /** When the server stored it (ms since the epoch); `at` is the writer's claim. */
  time: number;
}

/** How a user's feed is shared, as the mailbox admin set it. */
export type Sharing = 'team' | 'private';

/** The users' events feeds: written on session lifecycle and status changes, read on demand. */
export interface Events {
  /** Append to the own user's feed. */
  publish(ev: SessionEvent, opts?: { timeoutMs?: number }): Promise<void>;
  /**
   * `user`'s feed from `sinceMs` ago, oldest first: the first `max` events (default 10000) of
   * that window. Throws an error with `.notShared === true` when the server does not let this user
   * read that feed (it is private, or there is no such user: the two look the same).
   */
  read(user: string, opts: { sinceMs: number; max?: number }): Promise<FeedEntry[]>;
  /** The users whose feed the admin shares with the team, or null when the server has no list. */
  shared(): Promise<string[] | null>;
}

// ---------------------------------------------------------------- the transport seam

/** What a handler for a delivery may return: `{ackAfter}` defers the acknowledgement. */
export type DeliveryResult = void | undefined | { ackAfter: Promise<unknown> };

export interface SubscribeOptions {
  /** Names the durable position, so mail that arrives while nobody is listening is queued. */
  session: string;
  /**
   * This session's addresses (and aliases), plus 'all' for broadcasts, `area:<area>` for each
   * help area it offers (asks in it are read like broadcasts: no server-side acknowledgement, the
   * saved cursor is the position; an area new to the cursor is read from the oldest stored ask) and
   * the service addresses `<user>.<name>` it has claimed (read from the service's own durable
   * position, and only while the claim names `session`).
   */
  addresses: string[];
  /** Only used when the durable position has to be rebuilt. */
  cursor?: Cursor;
  /**
   * Ends the subscription (an AbortError). Honoured at every stage, also while it is still
   * connecting or setting up: a caller that stops it must never wait for a slow broker.
   */
  signal?: AbortSignal;
  /** Called each time the subscription is (re)established. */
  onOpen?: () => void | Promise<void>;
  /**
   * A service address among `addresses` is not (or no longer) claimed by `session`: its mail is
   * left for the holder, and this subscription stops reading it.
   */
  onServiceLost?: (service: string) => void;
  /** Calls never overlap; resolving acknowledges (or `{ackAfter}` later). At-least-once. */
  onMessage: (delivery: Delivery) => DeliveryResult | Promise<DeliveryResult>;
  /** An unacknowledged delivery is offered again after this long (default 60 s). */
  redeliverAfterMs?: number;
  /** Safety-net poll for broadcasts (default 30 s). */
  broadcastPollMs?: number;
  /**
   * Ending the subscription stops taking deliveries, waits up to this long for the ones already
   * handed out to be acknowledged or handed back (default 3 s), then hands back the rest, oldest
   * first. A subscription that starts while earlier deliveries are still unacknowledged holds
   * what it receives until they are back (or a little past redeliverAfterMs), so the session's
   * mail reaches onMessage in stream order across subscribers.
   */
  settleMs?: number;
}

export interface PollOptions {
  lookbackMs: number;
  /** At most this many per address (default 256; Infinity pages through everything). */
  max?: number;
}

export interface PresenceOptions {
  timeoutMs?: number;
}

/** The presence registry: who is online. Entries expire on their own when not refreshed. */
export interface Presence {
  /** "I'm online". The core sends one every ten minutes as a heartbeat. */
  announce(rec: PresenceRecord, opts?: PresenceOptions): Promise<void>;
  heartbeat(rec: PresenceRecord, opts?: PresenceOptions): Promise<void>;
  /** "I'm gone". */
  depart(rec: PresenceRecord, opts?: PresenceOptions): Promise<void>;
  /** Change metadata (aliases) without asserting liveness. */
  update(rec: PresenceRecord, opts?: PresenceOptions): Promise<void>;
  /** Live entries whose user is the server-verified writer. */
  list(): Promise<PresenceEntry[]>;
}

// ---------------------------------------------------------------- service addresses

/**
 * A claim on a service address, as written by the session that holds it. The field names and their
 * order are the wire format (test/golden-presence.test.ts).
 */
export interface ServiceClaimRecord {
  /** The service address, `<user>.<name>`. */
  service: string;
  /** The holding session's address. */
  holder: string;
  /** The holding session's id: what says which session holds it. */
  session: string;
  /** ISO-8601, when the holder last wrote it (self-asserted). */
  at: string;
}

/** A claim as `services.read()` / `services.list()` return it: checked, with the server's time. */
export interface ServiceClaim extends Omit<ServiceClaimRecord, 'at'> {
  /** The writer's claim; null when malformed. */
  at: string | null;
  /** When the server stored it (ms since the epoch). */
  lastSeen: number;
}

/**
 * Claims on service addresses: one entry per service, written only by its user's sessions, with
 * compare-and-set versions so that two sessions claiming at once cannot both win. An entry expires
 * when its holder stops refreshing it (with presence), so a claim is only as live as its holder.
 */
export interface Services {
  /**
   * The current claim on `service` and the entry's version: 0 when there is no entry at all.
   * `claim` is null when the entry is released or malformed (then the version still counts).
   */
  read(service: string): Promise<{ claim: ServiceClaim | null; version: number }>;
  /**
   * Write `claim` (a service of the own user) if the entry is still at `version`; false when it
   * changed since it was read.
   */
  write(claim: ServiceClaimRecord, version: number): Promise<boolean>;
  /** Release `service` if its entry is still at `version`; false when it changed meanwhile. */
  remove(service: string, version: number): Promise<boolean>;
  /** Every user's current claims (well-formed ones only). */
  list(): Promise<ServiceClaim[]>;
}

/** One line of `mbox doctor`. */
export interface DiagnoseCheck {
  ok: boolean;
  name: string;
  hint?: string;
}

/**
 * The broker, as the core sees it. Addresses are `<user>.<host>.<label>` strings and service
 * addresses `<user>.<name>`, plus the broadcast pseudo-address 'all'. The contract is written out in src/core/transport/nats.ts,
 * the one implementation.
 */
export interface Transport {
  /**
   * Store `envelope` durably for one address (a session's or a service's), 'all' or an area
   * (`area:<area>`, an ask); a retry with the same id is deduped.
   */
  publish(to: string, envelope: Envelope, opts?: { timeoutMs?: number }): Promise<{ id: string }>;
  /** Deliver mail for the addresses plus broadcasts. Never resolves: it rejects when the connection ends, or with an AbortError when `signal` aborts. */
  subscribe(opts: SubscribeOptions): Promise<never>;
  /** Stored messages, oldest first, with no side effects. */
  poll(addresses: string[], opts: PollOptions): Promise<Delivery[]>;
  /** The "start from here" cursor for a brand-new session. */
  now(): Promise<Cursor>;
  presence: Presence;
  events: Events;
  services: Services;
  /** Whether this user can read asks: false on a server set up before help areas. */
  asksReadable(): Promise<boolean>;
  limits: {
    /** The longest label that still forms a routable address. */
    maxLabelLen(user: string, host: string): number;
  };
  /** A human-readable message for any error thrown by the transport. */
  explainError(err: unknown): string;
  /** Connectivity / authentication / permission self-check for `mbox doctor`. */
  diagnose(opts: { user: string; host: string }): Promise<DiagnoseCheck[]>;
  /** Release connections; call before exiting. */
  close(): Promise<void>;
}

/** Options of `createTransport`. */
export interface TransportOptions {
  /** A long-running process serving many sessions: every subscription shares one connection. */
  multiplex?: boolean;
  /** Test-only fault injection (see TransportFaults); never set outside the tests. */
  faults?: TransportFaults;
}

/**
 * Test-only knobs that force the orderings a handover can produce, whatever the machine's speed.
 * Set from AGENT_MAILBOX_TEST_* environment variables by the CLI.
 */
export interface TransportFaults {
  /**
   * An ending subscription loses the newest N messages it would hand back, as if the server had
   * sent them in the instant the pull ended: they come back only after redeliverAfterMs.
   */
  loseHandBack?: number;
  /** An ending subscription waits this long before handing back. */
  handBackDelayMs?: number;
  /** A starting subscription waits this long after reading its durable position, before taking mail. */
  startDelayMs?: number;
}
