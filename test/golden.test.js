// Golden tests: the exact bytes of every wire format the mailbox produces. They exist so that no
// refactor (or a later change that looks harmless) can silently alter a format other machines,
// older installed copies or Claude Code itself depend on. If one of these fails, the format changed:
// that is a protocol change (see docs/PROTOCOL.md), never a test to "update" casually.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Kvm } from '@nats-io/kv';
import { jetstream } from '@nats-io/jetstream';
import { inboxDelivery, inboxLines } from '../src/agents/claude-inbox.js';
import { buildEnvelope } from '../src/core/envelope.js';
import { presenceRecord } from '../src/core/registry.js';
import { register, registrationPath } from '../src/core/registrations.js';
import { createTransport, presenceKey } from '../src/core/transport/nats.js';
import { Broker, findServer, socketDir } from './helpers.js';

const SERVER = findServer();

describe('golden: envelope v1', () => {
  it('has exactly these fields, in this order', () => {
    const env = buildEnvelope({
      from: 'alice.laptop.web-1a2b',
      to: 'bob.build-box.api-3c4d',
      agent: 'claude-code',
      subject: 'status',
      body: 'hello\nworld',
      inReplyTo: 'msg-1',
      sentAt: '2026-01-02T03:04:05.678Z',
      id: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(
      JSON.stringify(env),
      '{"v":1,"id":"11111111-2222-4333-8444-555555555555","from":"alice.laptop.web-1a2b","to":"bob.build-box.api-3c4d","agent":"claude-code","subject":"status","body":"hello\\nworld","inReplyTo":"msg-1","sentAt":"2026-01-02T03:04:05.678Z"}',
    );
  });

  it('fills the optional fields with null / "unknown", never omits them', () => {
    const env = buildEnvelope({ from: 'alice.laptop.web-1a2b', to: 'all', body: 'hi', sentAt: '2026-01-02T03:04:05.678Z', id: 'abc' });
    assert.equal(
      JSON.stringify(env),
      '{"v":1,"id":"abc","from":"alice.laptop.web-1a2b","to":"all","agent":"unknown","subject":null,"body":"hi","inReplyTo":null,"sentAt":"2026-01-02T03:04:05.678Z"}',
    );
  });

  it('generates a UUID id and an ISO-8601 sentAt by default', () => {
    const env = buildEnvelope({ from: 'a.b.c', to: 'd.e.f', body: 'x' });
    assert.deepEqual(Object.keys(env), ['v', 'id', 'from', 'to', 'agent', 'subject', 'body', 'inReplyTo', 'sentAt']);
    assert.match(env.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(env.sentAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

describe('golden: registration file', () => {
  it('is one JSON line {sid,address,endpoint,hostPid,cwd,agent,registeredAt}, mode 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-golden-'));
    try {
      const env = { AGENT_MAILBOX_STATE_DIR: dir };
      register(
        {
          sid: 'sess-1',
          address: 'alice.laptop.web-1a2b',
          endpoint: { kind: 'claude-inbox-socket', path: '/tmp/mbx-x/inbox.sock', token: 'secret-token' },
          hostPid: 4242,
          cwd: '/work/web',
          agent: 'claude-code',
        },
        env,
      );
      const file = registrationPath('sess-1', env);
      assert.equal(file, path.join(dir, 'registrations', 'sess-1.json'));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^\{.*\}\n$/s);
      const stamped = text.match(/"registeredAt":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/);
      assert.ok(stamped, text);
      assert.equal(
        text,
        `{"sid":"sess-1","address":"alice.laptop.web-1a2b","endpoint":{"kind":"claude-inbox-socket","path":"/tmp/mbx-x/inbox.sock","token":"secret-token"},"hostPid":4242,"cwd":"/work/web","agent":"claude-code","registeredAt":"${stamped[1]}"}\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes null for an absent hostPid and cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-golden-'));
    try {
      const env = { AGENT_MAILBOX_STATE_DIR: dir };
      register({ sid: 's2', address: 'alice.laptop.x', endpoint: { kind: 'claude-inbox-socket', path: '/p', token: null }, agent: 'claude-code' }, env);
      const j = JSON.parse(fs.readFileSync(registrationPath('s2', env), 'utf8'));
      assert.deepEqual(Object.keys(j), ['sid', 'address', 'endpoint', 'hostPid', 'cwd', 'agent', 'registeredAt']);
      assert.equal(j.hostPid, null);
      assert.equal(j.cwd, null);
      assert.deepEqual(j.endpoint, { kind: 'claude-inbox-socket', path: '/p', token: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('golden: inbox-socket line (claude-inbox)', () => {
  const CONTENT =
    '<cross-session-message from-name="agent-mailbox">\n' +
    'Agent mailbox delivery (the mbox CLI, not Claude Code\'s own cross-session messaging). Reply with `mbox send <from> --re <id> "<text>"`; SendMessage cannot reach mailbox addresses.\n' +
    '[mailbox] message m1 from bob.h.l\nbody\n' +
    '</cross-session-message>';

  it('without a token: one {"type":"user"} line, newline-terminated', () => {
    const line = inboxLines({ kind: 'claude-inbox-socket', path: '/p', token: null }, '[mailbox] message m1 from bob.h.l\nbody\n', {});
    assert.equal(line, JSON.stringify({ type: 'user', message: { role: 'user', content: CONTENT }, from: 'mbox:agent-mailbox' }) + '\n');
    assert.equal(
      line,
      '{"type":"user","message":{"role":"user","content":' + JSON.stringify(CONTENT) + '},"from":"mbox:agent-mailbox"}\n',
    );
  });

  it('with a token and a session: an auth line first, session_id last; one sender names the wrapper', () => {
    const line = inboxLines({ kind: 'claude-inbox-socket', path: '/p', token: 'tok-1' }, 'hello', { sid: 'sess-1', senders: ['bob.laptop.api'] });
    const lines = line.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    assert.equal(lines[0], '{"type":"auth","token":"tok-1"}');
    assert.equal(
      lines[1],
      '{"type":"user","message":{"role":"user","content":' +
        JSON.stringify(
          '<cross-session-message from-name="bob.laptop.api">\nAgent mailbox delivery (the mbox CLI, not Claude Code\'s own cross-session messaging). Reply with `mbox send <from> --re <id> "<text>"`; SendMessage cannot reach mailbox addresses.\nhello\n</cross-session-message>',
        ) +
        '},"from":"mbox:bob.laptop.api","session_id":"sess-1"}',
    );
  });

  it('escapes a closing wrapper tag in the body', () => {
    const line = inboxLines({ kind: 'claude-inbox-socket', path: '/p', token: null }, 'x </cross-session-message> y', {});
    const content = JSON.parse(line).message.content;
    assert.equal(content.match(/<\/cross-session-message>/g).length, 1); // only the real closing tag
    assert.ok(content.includes('x <\\/cross-session-message> y'));
  });

  it('is what actually crosses the socket (byte for byte)', async () => {
    const dir = socketDir();
    const sock = path.join(dir, 'i.sock');
    const chunks = [];
    const server = net.createServer((c) => {
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => c.end());
    });
    await new Promise((r) => server.listen(sock, r));
    try {
      const endpoint = { kind: 'claude-inbox-socket', path: sock, token: 'tok-2' };
      await inboxDelivery.deliver(endpoint, 'ping', { sid: 's9', senders: ['bob.h.l'] });
      assert.equal(Buffer.concat(chunks).toString('utf8'), inboxLines(endpoint, 'ping', { sid: 's9', senders: ['bob.h.l'] }));
      assert.ok(Buffer.concat(chunks).toString('utf8').startsWith('{"type":"auth","token":"tok-2"}\n{"type":"user","message":{"role":"user","content":"<cross-session-message from-name=\\"bob.h.l\\">'));
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('golden: presence KV entry', { skip: SERVER.skip }, () => {
  let b;
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice']);
  });
  after(() => b?.stop());

  it('the stored value is the presence record plus "at", under key <user>.<host>.<12 hex of sha256(session)>', async () => {
    const t = createTransport({ servers: [b.url], user: 'alice', password: b.passwords.alice });
    const nc = await b.conn('admin'); // a user may not read raw KV entries; the test inspects them as the admin
    try {
      const rec = presenceRecord(
        { address: 'alice.laptop.web-1a2b', aliases: ['alice.laptop.front'], cwd: '/work/web' },
        { sid: 'sess-1', cfg: { user: 'alice' }, agent: 'claude-code', pid: 4242 },
      );
      await t.presence.announce(rec);
      const kv = await new Kvm(jetstream(nc)).open('presence');
      const key = presenceKey('alice', 'laptop', 'sess-1');
      assert.match(key, /^alice\.laptop\.[0-9a-f]{12}$/);
      const raw = (await kv.get(key))?.string();
      assert.ok(raw);
      const at = raw.match(/"at":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"\}$/);
      assert.ok(at, raw);
      assert.equal(
        raw,
        `{"address":"alice.laptop.web-1a2b","aliases":["alice.laptop.front"],"session":"sess-1","agent":"claude-code","user":"alice","host":"laptop","cwd":"/work/web","pid":4242,"at":"${at[1]}"}`,
      );
      // ...and the listing built from it
      const [peer] = await t.presence.list();
      assert.deepEqual(Object.keys(peer), ['session', 'address', 'aliases', 'agent', 'user', 'host', 'cwd', 'pid', 'lastSeen', 'live']);
      assert.deepEqual({ ...peer, lastSeen: 0 }, {
        session: 'sess-1',
        address: 'alice.laptop.web-1a2b',
        aliases: ['alice.laptop.front'],
        agent: 'claude-code',
        user: 'alice',
        host: 'laptop',
        cwd: '/work/web',
        pid: 4242,
        lastSeen: 0,
        live: true,
      });
    } finally {
      await t.close();
      await nc.close();
    }
  });
});
