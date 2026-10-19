// The snapshot socket (src/core/uiserver.ts) with a stand-in transport: permissions, the HTTP
// API, ETag / 304 and what invalidates a cached snapshot. No server needed; test/ui-socket.test.ts
// covers it inside a real delivery daemon.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { appendSentLog, sentRecord } from '../src/core/sentlog.js';
import { statePath } from '../src/core/state.js';
import type { Delivery, Env, PresenceEntry, Snapshot } from '../src/core/types.js';
import { probeUiSocket, startUiServer, uiSocketPath, type UiServer } from '../src/core/uiserver.js';
import { socketDir } from './helpers.js';
import { describe, it } from './suite.js';

interface Got {
  status: number;
  etag: string | undefined;
  body: string;
}

/** One HTTP request over the unix socket. */
function get(socketPath: string, url: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A short state directory (unix socket paths are limited to about 100 bytes). */
function machine(): Env & { AGENT_MAILBOX_STATE_DIR: string } {
  const dir = path.join(socketDir(), 'st');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return { AGENT_MAILBOX_STATE_DIR: dir };
}

const ME = 'alice.laptop.web-1a2b';
function writeState(env: Env, sid: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    statePath(sid, env),
    JSON.stringify({
      address: ME,
      aliases: [],
      cwd: '/nowhere',
      createdAt: '2026-10-19T00:00:00Z',
      ...extra,
    }),
    { mode: 0o600 },
  );
}

const peer = (address: string, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  session: `s-${address}`,
  address,
  aliases: [],
  agent: 'claude-code',
  user: address.split('.')[0] ?? '',
  host: address.split('.')[1] ?? '',
  cwd: null,
  pid: null,
  repo: null,
  branch: null,
  role: null,
  parent: null,
  status: null,
  offers: [],
  title: null,
  lastSeen: Date.now(),
  live: true,
  ...extra,
});

/** A transport stand-in that counts what it is asked. */
function fakeTransport() {
  const t = {
    peers: [peer('bob.desk.x-1')],
    mail: [] as Delivery[],
    lists: 0,
    polls: 0,
    presence: {
      list: () => {
        t.lists++;
        return Promise.resolve(t.peers.map((p) => ({ ...p })));
      },
    },
    services: { list: () => Promise.resolve([]) },
    poll: () => {
      t.polls++;
      return Promise.resolve([...t.mail]);
    },
    explainError: (e: unknown) => String(e),
  };
  return t;
}

describe('snapshot socket', () => {
  const servers: UiServer[] = [];
  // A failed test must not leave a server listening (the process would never exit).
  after(() => Promise.all(servers.map((u) => u.close())));
  const start = async (
    env: Env,
    t: ReturnType<typeof fakeTransport>,
    served = (sid: string) => sid === 'sess-1',
    opts: { peersRefreshMs?: number } = {},
  ): Promise<UiServer> => {
    const ui = await startUiServer({
      cfg: { user: 'alice' },
      // the stand-in implements exactly what the server calls
      transport: t as unknown as Parameters<typeof startUiServer>[0]['transport'],
      env,
      served,
      ...opts,
    });
    assert.ok(ui);
    servers.push(ui);
    return ui;
  };

  it('is a 0600 socket in the state directory; 404 for unknown sessions, 400 for bad input', async () => {
    const env = machine();
    writeState(env, 'sess-1');
    const t = fakeTransport();
    const ui = await start(env, t);
    try {
      assert.equal(ui.path, uiSocketPath(env));
      const st = fs.lstatSync(ui.path);
      assert.ok(st.isSocket());
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(await probeUiSocket(env), ui.path);
      assert.equal((await get(ui.path, '/v1/snapshot?session=other')).status, 404);
      assert.equal((await get(ui.path, '/v1/snapshot?session=..%2Fx')).status, 400);
      assert.equal((await get(ui.path, '/v1/snapshot?session=sess-1&since=1y')).status, 400);
      assert.equal((await get(ui.path, '/v1/snapshot?session=sess-1&since=31d')).status, 400);
      assert.equal((await get(ui.path, '/v2/anything')).status, 404);
      const ok = await get(ui.path, '/v1/snapshot?session=sess-1');
      assert.equal(ok.status, 200, ok.body);
      const snap = JSON.parse(ok.body) as Snapshot;
      assert.equal(snap.self.address, ME);
      assert.equal(snap.socket, ui.path);
      assert.equal(snap.since, '24h');
      assert.deepEqual(
        snap.peers.map((p) => p.address),
        ['bob.desk.x-1'],
      );
    } finally {
      await ui.close();
    }
    assert.ok(!fs.existsSync(ui.path), 'the socket is removed on close');
    assert.equal(await probeUiSocket(env), null);
  });

  it('answers an unchanged poll with 304; mail, presence, state and the sent log invalidate', async () => {
    const env = machine();
    writeState(env, 'sess-1');
    const t = fakeTransport();
    const ui = await start(env, t, undefined, { peersRefreshMs: 0 }); // presence re-read every time
    const poll = (etag?: string) =>
      get(ui.path, '/v1/snapshot?session=sess-1', etag ? { 'If-None-Match': etag } : {});
    const first = await poll();
    assert.equal(first.status, 200);
    assert.match(first.etag ?? '', /^"[0-9a-f]{32}"$/);
    const polls = t.polls;
    const same = await poll(first.etag);
    assert.equal(same.status, 304);
    assert.equal(same.body, '');
    assert.equal(t.polls, polls, 'an unchanged poll reads no mail');

    // a heartbeat (lastSeen only) changes nothing
    t.peers = t.peers.map((p) => ({ ...p, lastSeen: p.lastSeen + 1000 }));
    assert.equal((await poll(first.etag)).status, 304);
    assert.equal(t.polls, polls);

    // mail for the session: invalidated by the daemon
    t.mail.push({
      id: 'd1',
      time: Math.floor(Date.now() / 1000),
      to: ME,
      sender: 'bob',
      payload: JSON.stringify({ v: 1, id: 'm1', from: 'bob.desk.x-1', to: ME, body: 'hello' }),
      cursor: null,
    });
    assert.equal((await poll(first.etag)).status, 304, 'not invalidated yet: still cached');
    ui.invalidate('sess-1');
    const withMail = await poll(first.etag);
    assert.equal(withMail.status, 200);
    assert.deepEqual(
      (JSON.parse(withMail.body) as Snapshot).mail.map((m) => m.id),
      ['m1'],
    );

    // presence: a new peer
    t.peers.push(peer('carol.h.y-2', { title: 'Carol' }));
    const withPeer = await poll(withMail.etag);
    assert.equal(withPeer.status, 200);
    assert.equal((JSON.parse(withPeer.body) as Snapshot).peers.length, 2);

    // the state file (mbox status)
    writeState(env, 'sess-1', { status: 'busy' });
    const withStatus = await poll(withPeer.etag);
    assert.equal(withStatus.status, 200);
    assert.equal((JSON.parse(withStatus.body) as Snapshot).self.status, 'busy');

    // the sent log (mbox send)
    appendSentLog(
      'sess-1',
      sentRecord({ id: 'o1', to: 'bob.desk.x-1', subject: null, body: 'hi', inReplyTo: null }),
      env,
    );
    const withSent = await poll(withStatus.etag);
    assert.equal(withSent.status, 200);
    assert.deepEqual(
      (JSON.parse(withSent.body) as Snapshot).sent.map((s) => s.id),
      ['o1'],
    );
    assert.equal((await poll(withSent.etag)).status, 304);

    // no longer served: 404, and its cache is gone
    ui.drop('sess-1');
    await ui.close();
  });

  it('does not serve from a directory open to others, or over something that is not a socket; replaces a dead socket', async () => {
    const logs: string[] = [];
    const t = fakeTransport();
    const open = machine();
    fs.chmodSync(open.AGENT_MAILBOX_STATE_DIR, 0o755);
    const refused = await startUiServer({
      cfg: { user: 'alice' },
      transport: t as unknown as Parameters<typeof startUiServer>[0]['transport'],
      env: open,
      served: () => true,
      log: (l) => logs.push(l),
    });
    assert.equal(refused, null);
    assert.match(logs.join('\n'), /open to other users \(mode 755; chmod 700 it\)/);
    assert.ok(!fs.existsSync(uiSocketPath(open)));

    const blocked = machine();
    fs.writeFileSync(uiSocketPath(blocked), 'keep me');
    const refused2 = await startUiServer({
      cfg: { user: 'alice' },
      transport: t as unknown as Parameters<typeof startUiServer>[0]['transport'],
      env: blocked,
      served: () => true,
      log: (l) => logs.push(l),
    });
    assert.equal(refused2, null);
    assert.equal(fs.readFileSync(uiSocketPath(blocked), 'utf8'), 'keep me');
    assert.match(logs.join('\n'), /exists and is not a socket/);

    // a socket nobody listens on (its daemon was killed) is replaced
    const stale = machine();
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(uiSocketPath(stale), r));
    // close without removing the file, as a killed process leaves it
    const fd = fs.lstatSync(uiSocketPath(stale)).ino;
    await new Promise<void>((r) => dead.close(() => r()));
    if (!fs.existsSync(uiSocketPath(stale))) {
      // this Node removed it on close: recreate a dead one by hand
      const again = net.createServer();
      await new Promise<void>((r) => again.listen(uiSocketPath(stale), r));
      fs.renameSync(uiSocketPath(stale), uiSocketPath(stale) + '.x');
      await new Promise<void>((r) => again.close(() => r()));
      fs.renameSync(uiSocketPath(stale) + '.x', uiSocketPath(stale));
    }
    assert.ok(fd > 0 && fs.lstatSync(uiSocketPath(stale)).isSocket());
    assert.equal(await probeUiSocket(stale), null);
    writeState(stale, 'sess-1');
    const ui = await start(stale, t);
    assert.equal((await get(ui.path, '/v1/snapshot?session=sess-1')).status, 200);
    await ui.close();
  });
});
