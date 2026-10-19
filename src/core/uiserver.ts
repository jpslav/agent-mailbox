// The delivery daemon's snapshot socket: `GET /v1/snapshot?session=<id>&since=24h` over HTTP on a
// unix socket, `<state>/ui.sock`, answers with what `mbox snapshot --json` prints for a session the
// daemon serves, so a side panel can poll without spawning a process. Only the daemon holding the
// lock serves it (deliverd.ts starts it after taking the lock and closes it before letting go).
//
// Access is the file system's: the socket is 0600 inside the state directory, which must belong to
// this user and be closed to everyone else (0700), or nothing is served. Whoever can connect can
// read every served session's mail, exactly as they could read the state directory and the
// client config next to it (docs/DECISIONS.md, "The snapshot socket").
//
// Cheap when nothing changed: one cached snapshot per session and lookback, rebuilt only when the
// daemon received mail for the session, presence changed (re-read at most every PEERS_REFRESH_MS;
// lastSeen alone does not count), the session's state or sent log changed (their size and mtime,
// checked per request), or it is older than MAX_AGE_MS (the lookback window moves). The ETag is a
// hash of the snapshot without its build time, so an unchanged poll gets 304 even after a rebuild.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  SINCE_RE,
  canonicalSince,
  SNAPSHOT_SINCE,
  SNAPSHOT_SINCE_MAX_MS,
  gatherSnapshot,
  sinceToMs,
} from './snapshot.js';
import { sentLogPath, readState, stateDir, statePath, validateSessionId } from './state.js';
import { lenientString } from './text.js';
import type { Config, Env, PresenceEntry, ServiceClaim, Snapshot, Transport } from './types.js';

/** Where the daemon of this profile serves snapshots. */
export const uiSocketPath = (env: Env = process.env): string => path.join(stateDir(env), 'ui.sock');

/** The longest unix socket path every supported platform takes (macOS: 104 bytes with the NUL). */
const SOCKET_PATH_MAX = 103;
/** Presence is re-read at most this often (the transport has no change feed for it). */
export const PEERS_REFRESH_MS = 30000;
/** A cached snapshot is rebuilt after this long even when nothing changed. */
export const MAX_AGE_MS = 5 * 60000;
/** The most lookbacks cached per session. */
const MAX_VARIANTS = 4;

export interface UiServerInput {
  cfg: Pick<Config, 'user'>;
  transport: Pick<Transport, 'presence' | 'services' | 'poll' | 'explainError'>;
  env?: Env;
  /** Does the daemon serve this session now? Only those get snapshots. */
  served: (sid: string) => boolean;
  log?: (line: string) => void;
  /** Tests only: shorter refresh and age. */
  peersRefreshMs?: number;
  maxAgeMs?: number;
}

export interface UiServer {
  path: string;
  /** Mail for the session arrived: its next snapshot is rebuilt. */
  invalidate(sid: string): void;
  /** The session is no longer served: forget its snapshots. */
  drop(sid: string): void;
  /** Stop serving and remove the socket (if it is still this server's). */
  close(): Promise<void>;
}

interface Entry {
  body: string;
  etag: string;
  builtAt: number;
  mailGen: number;
  presenceGen: number;
  stamp: string;
}

interface SessionCache {
  mailGen: number;
  variants: Map<string, Entry>;
  building: Map<string, Promise<Entry | null>>;
}

interface PresenceView {
  at: number;
  peers: PresenceEntry[];
  claims: ServiceClaim[];
  sig: string;
  gen: number;
}

/** A file's size and mtime, or '' when it is missing: compared to tell that it changed. */
function stamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

/** An error's code (ENOENT, ...) or message, for a log line. */
const errName = (e: unknown): string => {
  const x = e as { code?: unknown; message?: unknown } | null;
  return lenientString(x?.code ?? x?.message ?? 'error').slice(0, 120);
};

/** Why `dir` must not hold the socket, or null when it is this user's and closed to others. */
function unsafeDir(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    return `cannot read ${dir} (${errName(e)})`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    return `${dir} belongs to another user`;
  if (st.mode & 0o077)
    return `${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}; chmod 700 it)`;
  return null;
}

/**
 * Start serving snapshots, or resolve to null (logged) when it cannot be done safely: the path is
 * too long for a socket, the directory is open to others, or something that is not a socket is
 * in the way. A socket left behind by a daemon that died is replaced.
 */
export async function startUiServer(input: UiServerInput): Promise<UiServer | null> {
  const { cfg, transport, env = process.env, served, log = () => {} } = input;
  const peersRefreshMs = input.peersRefreshMs ?? PEERS_REFRESH_MS;
  const maxAgeMs = input.maxAgeMs ?? MAX_AGE_MS;
  const file = uiSocketPath(env);
  const notServing = (why: string): null => {
    log(`not serving snapshots: ${why}`);
    return null;
  };
  if (Buffer.byteLength(file) > SOCKET_PATH_MAX)
    return notServing(`the socket path is longer than ${SOCKET_PATH_MAX} bytes (${file})`);
  const bad = unsafeDir(path.dirname(file));
  if (bad) return notServing(bad);
  try {
    const old = fs.lstatSync(file);
    if (!old.isSocket()) return notServing(`${file} exists and is not a socket`);
    fs.rmSync(file, { force: true }); // left by a daemon that is gone: we hold the lock
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      return notServing(`cannot replace ${file} (${errName(e)})`);
  }

  const sessions = new Map<string, SessionCache>();
  let presence: PresenceView | null = null;
  let presenceLoad: Promise<PresenceView> | null = null;

  async function loadPresence(): Promise<PresenceView> {
    const [peers, claims] = await Promise.all([
      transport.presence.list(),
      transport.services.list().catch((): ServiceClaim[] => []),
    ]);
    // What a snapshot shows of presence, minus lastSeen (a heartbeat alone changes nothing drawn).
    const sig = JSON.stringify([
      peers.map((p) => ({ ...p, lastSeen: 0 })),
      claims.map((c) => [c.service, c.holder, c.session]),
    ]);
    const gen = !presence ? 1 : presence.sig === sig ? presence.gen : presence.gen + 1;
    presence = { at: Date.now(), peers, claims, sig, gen };
    return presence;
  }

  function currentPresence(): Promise<PresenceView> {
    if (presence && Date.now() - presence.at < peersRefreshMs) return Promise.resolve(presence);
    presenceLoad ??= loadPresence().finally(() => (presenceLoad = null));
    return presenceLoad;
  }

  function cacheOf(sid: string): SessionCache {
    let sc = sessions.get(sid);
    if (!sc) {
      sc = { mailGen: 0, variants: new Map(), building: new Map() };
      sessions.set(sid, sc);
    }
    return sc;
  }

  async function build(sid: string, since: string, sc: SessionCache): Promise<Entry | null> {
    const mailGen = sc.mailGen;
    const pv = await currentPresence();
    const fileStamp = `${stamp(statePath(sid, env))}|${stamp(sentLogPath(sid, env))}`;
    const st = readState(sid, env);
    if (!st) return null;
    const snap: Snapshot = await gatherSnapshot({
      transport,
      user: cfg.user,
      sid,
      state: st,
      since,
      sinceMs: sinceToMs(since),
      socket: file,
      peers: pv.peers,
      claims: pv.claims,
      env,
    });
    const body = JSON.stringify(snap);
    const etag = `"${crypto
      .createHash('sha256')
      .update(JSON.stringify({ ...snap, at: 0 }))
      .digest('hex')
      .slice(0, 32)}"`;
    const entry = {
      body,
      etag,
      builtAt: Date.now(),
      mailGen,
      presenceGen: pv.gen,
      stamp: fileStamp,
    };
    if (sessions.get(sid) === sc) {
      sc.variants.delete(since);
      sc.variants.set(since, entry);
      for (const k of sc.variants.keys()) {
        if (sc.variants.size <= MAX_VARIANTS) break;
        sc.variants.delete(k); // the least recently built
      }
    }
    return entry;
  }

  /** The session's snapshot for `since`: cached while nothing it shows can have changed. */
  async function snapshotFor(sid: string, since: string): Promise<Entry | null> {
    const sc = cacheOf(sid);
    const pv = await currentPresence();
    const e = sc.variants.get(since);
    if (
      e &&
      e.mailGen === sc.mailGen &&
      e.presenceGen === pv.gen &&
      e.stamp === `${stamp(statePath(sid, env))}|${stamp(sentLogPath(sid, env))}` &&
      Date.now() - e.builtAt < maxAgeMs
    )
      return e;
    const join = (): Promise<Entry | null> => {
      let p = sc.building.get(since);
      if (!p) {
        p = build(sid, since, sc).finally(() => sc.building.delete(since));
        sc.building.set(since, p);
      }
      return p;
    };
    const got = await join();
    // A build that began before mail came in may not show it: build once more for this request.
    return got && got.mailGen !== sc.mailGen ? join() : got;
  }

  const reply = (
    res: http.ServerResponse,
    code: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...headers,
    });
    res.end(body);
  };
  const error = (res: http.ServerResponse, code: number, message: string): void =>
    reply(res, code, JSON.stringify({ error: message }) + '\n');

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      error(res, 405, 'only GET');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/snapshot') {
      error(res, 404, 'not found; the endpoint is /v1/snapshot?session=<id>&since=24h');
      return;
    }
    const asked = url.searchParams.get('since') ?? SNAPSHOT_SINCE;
    if (!SINCE_RE.test(asked) || sinceToMs(asked) > SNAPSHOT_SINCE_MAX_MS) {
      error(res, 400, 'since must look like 30m, 2h or 1d, and be at most 30d');
      return;
    }
    // Equal lookbacks spelled differently share one cache entry (and one build).
    const since = canonicalSince(asked);
    let sid: string;
    try {
      sid = validateSessionId(url.searchParams.get('session') ?? '');
    } catch {
      error(res, 400, 'session must be a session id');
      return;
    }
    if (!served(sid)) {
      error(res, 404, 'no session with that id is served here');
      return;
    }
    let e: Entry | null;
    try {
      e = await snapshotFor(sid, since);
    } catch (err) {
      error(res, 503, transport.explainError(err));
      return;
    }
    if (!e || !served(sid)) {
      if (!served(sid)) sessions.delete(sid); // it stopped being served meanwhile
      error(res, 404, 'no session with that id is served here');
      return;
    }
    if (req.headers['if-none-match'] === e.etag) {
      res.writeHead(304, { ETag: e.etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    reply(res, 200, req.method === 'HEAD' ? '' : e.body + '\n', { ETag: e.etag });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) error(res, 500, String((err as Error)?.message ?? err).slice(0, 200));
      else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  let ino = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(file, 0o600);
    ino = fs.lstatSync(file).ino;
  } catch (e) {
    server.close();
    return notServing(`cannot listen on ${file} (${errName(e)})`);
  }
  server.on('error', (e) => log(`snapshot socket: ${errName(e)}`));
  log(`serving snapshots on ${file}`);

  let closing: Promise<void> | null = null;
  return {
    path: file,
    invalidate(sid) {
      const sc = sessions.get(sid);
      if (sc) sc.mailGen++;
    },
    drop(sid) {
      sessions.delete(sid);
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }).then(() => {
        try {
          if (fs.lstatSync(file).ino === ino) fs.rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      });
      return closing;
    },
  };
}

/**
 * The snapshot socket of this profile's daemon, if something listens on it (checked by connecting,
 * at most `timeoutMs`), else null.
 */
export async function probeUiSocket(
  env: Env = process.env,
  timeoutMs = 500,
): Promise<string | null> {
  const file = uiSocketPath(env);
  try {
    if (!fs.lstatSync(file).isSocket()) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const s = net.connect(file);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(ok ? file : null);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
