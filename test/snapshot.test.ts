// `mbox snapshot --json` assembly (src/core/snapshot.ts) and the sent log (src/core/sentlog.ts):
// pure parts, no server needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SENT_BODY_MAX,
  SENT_KEEP,
  appendSentLog,
  checkSentRecord,
  kindOf,
  readSentLog,
  sentRecord,
} from '../src/core/sentlog.js';
import {
  SNAPSHOT_BODY_MAX,
  SNAPSHOT_MAIL_MAX,
  buildSnapshot,
  buildThreads,
  canonicalSince,
  firstLine,
  snapshotAddresses,
  type SnapshotInput,
} from '../src/core/snapshot.js';
import { TITLE_MAX, checkTitle } from '../src/core/session-meta.js';
import { sentLogPath } from '../src/core/state.js';
import type {
  Delivery,
  PresenceEntry,
  SentRecord,
  SessionState,
  SnapshotMail,
} from '../src/core/types.js';
import { describe, it } from './suite.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const MIN = 60000;

const peer = (address: string, extra: Partial<PresenceEntry> = {}): PresenceEntry => {
  const [user = '', host = ''] = address.split('.');
  return {
    session: `s-${address}`,
    address,
    aliases: [],
    agent: 'claude-code',
    user,
    host,
    cwd: null,
    pid: null,
    repo: null,
    branch: null,
    role: null,
    parent: null,
    status: null,
    offers: [],
    title: null,
    lastSeen: NOW - MIN,
    live: true,
    ...extra,
  };
};

const env = (o: Record<string, unknown>): string => JSON.stringify({ v: 1, agent: 'x', ...o });
let seq = 0;
/** A delivery `minsAgo` minutes ago, read by the transport from `to`, verified as `sender`. */
const delivery = (
  to: string,
  sender: string | null,
  payload: string,
  minsAgo: number,
): Delivery => ({
  id: `d${++seq}`,
  time: Math.floor((NOW - minsAgo * MIN) / 1000),
  to,
  sender,
  payload,
  cursor: null,
});
const sent = (to: string, minsAgo: number, extra: Partial<SentRecord> = {}): SentRecord => ({
  ...sentRecord({
    id: `out-${++seq}`,
    to,
    subject: null,
    body: 'sent text',
    inReplyTo: null,
    time: NOW - minsAgo * MIN,
  }),
  ...extra,
});

const ME = 'alice.laptop.web-1a2b';
const state = (extra: Partial<SessionState> = {}): SessionState => ({
  address: ME,
  aliases: ['alice.laptop.front'],
  cwd: '/work/web',
  createdAt: '2026-10-19T00:00:00.000Z',
  ...extra,
});
const input = (extra: Partial<SnapshotInput> = {}): SnapshotInput => ({
  now: NOW,
  since: '24h',
  sinceMs: 24 * 60 * MIN,
  socket: null,
  user: 'alice',
  sid: 'sess-me',
  state: state(),
  repo: 'acme/web',
  branch: 'main',
  peers: [],
  claims: [],
  deliveries: [],
  sent: [],
  ...extra,
});

describe('snapshot', () => {
  it('has the contract keys, in order, and self from the state', () => {
    const snap = buildSnapshot(
      input({
        state: state({
          title: 'Fix login',
          status: 'testing',
          offers: ['repo:github.com/acme/web'],
          services: ['alice.helpdesk'],
        }),
        socket: '/run/ui.sock',
      }),
    );
    assert.deepEqual(Object.keys(snap), [
      'v',
      'at',
      'since',
      'socket',
      'self',
      'peers',
      'mail',
      'sent',
      'threads',
      'areas',
    ]);
    assert.deepEqual(snap.self, {
      address: ME,
      aliases: ['alice.laptop.front'],
      user: 'alice',
      host: 'laptop',
      title: 'Fix login',
      status: 'testing',
      role: null,
      parent: null,
      offers: ['repo:github.com/acme/web'],
      services: ['alice.helpdesk'],
      repo: 'acme/web',
      branch: 'main',
    });
    assert.equal(snap.v, 1);
    assert.equal(snap.at, NOW);
    assert.equal(snap.socket, '/run/ui.sock');
    assert.deepEqual(snap.areas, [
      { area: 'repo:github.com/acme/web', offeredBy: 1, isMine: true },
    ]);
  });

  it('reads the same addresses as inbox: own names, services, all, offered areas', () => {
    assert.deepEqual(
      snapshotAddresses(state({ services: ['alice.helpdesk'], offers: ['lang:ts'] })),
      [ME, 'alice.laptop.front', 'alice.helpdesk', 'all', 'area:lang:ts'],
    );
  });

  it('mail: kinds from where the transport read it, own broadcasts and asks skipped, bodies cut, mismatch flagged', () => {
    const long = 'x'.repeat(SNAPSHOT_BODY_MAX + 10);
    const snap = buildSnapshot(
      input({
        state: state({ offers: ['lang:ts'], services: ['alice.helpdesk'] }),
        deliveries: [
          delivery(ME, 'bob', env({ id: 'm1', from: 'bob.desk.x', to: ME, body: 'hi' }), 50),
          // a broadcast claiming to be direct mail stays a broadcast
          delivery('all', 'bob', env({ id: 'm2', from: 'bob.desk.x', to: ME, body: long }), 40),
          delivery('all', 'alice', env({ id: 'm3', from: ME, to: 'all', body: 'mine' }), 30),
          delivery('area:lang:ts', 'carol', env({ id: 'm4', from: 'mallory.h.l', body: 'q' }), 20),
          delivery('alice.helpdesk', 'bob', env({ id: 'm5', from: 'bob.desk.x', body: 's' }), 10),
          delivery(ME, 'bob', 'not an envelope', 5),
          delivery(ME, 'bob', env({ id: 'old', from: 'bob.desk.x', body: 'old' }), 25 * 60),
        ],
      }),
    );
    assert.deepEqual(
      snap.mail.map((m) => [m.id, m.kind, m.to, m.area, m.isMismatch, m.isTruncated]),
      [
        ['m1', 'direct', ME, null, false, false],
        ['m2', 'broadcast', 'all', null, false, true],
        ['m4', 'ask', 'area:lang:ts', 'lang:ts', true, false],
        ['m5', 'service', 'alice.helpdesk', null, false, false],
        [snap.mail[4]?.id, 'direct', ME, null, false, false],
      ],
    );
    assert.equal(snap.mail[1]?.body.length, SNAPSHOT_BODY_MAX);
    assert.equal(snap.mail[2]?.verifiedUser, 'carol');
    assert.equal(snap.mail[4]?.from, '(raw message)');
    assert.equal(snap.mail[0]?.time, Math.floor((NOW - 50 * MIN) / 1000) * 1000);
    assert.deepEqual(Object.keys(snap.mail[0] ?? {}), [
      'id',
      'from',
      'to',
      'kind',
      'area',
      'subject',
      'body',
      'isTruncated',
      'verifiedUser',
      'isMismatch',
      'inReplyTo',
      'sentAt',
      'time',
    ]);
  });

  it('threads pair mail and sent records by counterpart, and replies join their thread', () => {
    const mail = buildSnapshot(
      input({
        state: state({ offers: ['lang:ts'] }),
        deliveries: [
          delivery(ME, 'bob', env({ id: 'b1', from: 'bob.desk.x', body: 'hello\nmore' }), 50),
          delivery('area:lang:ts', 'carol', env({ id: 'ask1', from: 'carol.h.l', body: 'q?' }), 40),
          // a reply to my broadcast comes direct, and joins the broadcast's thread
          delivery(
            ME,
            'dave',
            env({ id: 'r1', from: 'dave.h.l', body: 'yes', inReplyTo: 'bc' }),
            9,
          ),
          delivery(
            ME,
            'erin',
            env({ id: 'r2', from: 'erin.h.l', body: 'ok', inReplyTo: 'svc1' }),
            4,
          ),
        ],
        sent: [
          sent('bob.desk.x', 45, { id: 'o1', inReplyTo: 'b1' }),
          sent('carol.h.l', 35, { id: 'o2', inReplyTo: 'ask1' }), // answering an ask
          sent('all', 10, { id: 'bc' }),
          sent('erin.svc', 5, { id: 'svc1' }),
          sent('alice.laptop.other', 25 * 60), // outside --since
        ],
      }),
    );
    assert.deepEqual(
      mail.threads.map((t) => [
        t.with,
        t.kind,
        t.count,
        t.isAwaitingMe,
        t.messages.map((m) => m.id),
      ]),
      [
        ['erin.svc', 'service', 2, true, ['svc1', 'r2']],
        ['all', 'broadcast', 2, true, ['bc', 'r1']],
        ['area:lang:ts', 'ask', 2, false, ['ask1', 'o2']],
        ['bob.desk.x', 'direct', 2, false, ['b1', 'o1']],
      ],
    );
    assert.equal(mail.threads[3]?.messages[0]?.firstLine, 'hello');
    assert.equal(mail.threads[0]?.lastAt, mail.mail.at(-1)?.time);
    assert.equal(mail.sent.length, 4);
  });

  it('spells equal lookbacks one way', () => {
    assert.deepEqual(['60m', '3600s', '1h', '01h', '24h', '1d', '90s', '0m'].map(canonicalSince), [
      '1h',
      '1h',
      '1h',
      '1h',
      '1d',
      '1d',
      '90s',
      '0s',
    ]);
  });

  it('mail to a service address this session holds is a thread per caller, not one per service', () => {
    const toService = (id: string, from: string, user: string, time: number): SnapshotMail => ({
      id,
      from,
      to: 'alice.helpdesk',
      kind: 'service',
      area: null,
      subject: null,
      body: id,
      isTruncated: false,
      verifiedUser: user,
      isMismatch: false,
      inReplyTo: null,
      sentAt: null,
      time,
    });
    const threads = buildThreads(
      [toService('q1', 'bob.desk.x', 'bob', 1), toService('q2', 'carol.h.l', 'carol', 2)],
      [sent('bob.desk.x', 0, { id: 'a1', inReplyTo: 'q1' })],
    );
    assert.deepEqual(threads.map((t) => [t.with, t.messages.map((m) => m.id).sort()]).sort(), [
      ['bob.desk.x', ['a1', 'q1']],
      ['carol.h.l', ['q2']],
    ]);
  });

  it('a forged or odd from never joins another thread; a reply joins its parent whatever the clocks say', () => {
    const snap = buildSnapshot(
      input({
        deliveries: [
          // mallory claims to be bob, and another claims to be the broadcast
          delivery(ME, 'mallory', env({ id: 'f1', from: 'bob.desk.x', body: 'forged' }), 30),
          delivery(ME, 'mallory', env({ id: 'f2', from: 'all', body: 'not a broadcast' }), 29),
          delivery(ME, 'bob', env({ id: 'b1', from: 'bob.desk.x', body: 'real' }), 28),
          // the reply arrives with a server time before the local time of the ask it answers
          delivery(
            ME,
            'carol',
            env({ id: 'r1', from: 'carol.h.l', body: 'a', inReplyTo: 'q1' }),
            20,
          ),
          delivery(
            ME,
            'bob',
            env({ id: 'long1', from: 'bob.desk.' + 'y'.repeat(5000), body: 'z' }),
            1,
          ),
        ],
        sent: [sent('area:lang:ts', 19, { id: 'q1' })],
      }),
    );
    assert.deepEqual(
      snap.threads.map((t) => [
        t.with.slice(0, 40),
        t.kind,
        t.messages.map((m) => m.id.slice(0, 5)),
      ]),
      [
        ['bob.desk.' + 'y'.repeat(31), 'direct', ['long1']], // cut, still bob's
        ['area:lang:ts', 'ask', ['r1', 'q1']],
        ['bob.desk.x', 'direct', ['b1']],
        ['unverified:mallory', 'direct', ['f1', 'f2']],
      ],
    );
    assert.ok(snap.mail.every((m) => m.id.length <= 256 && m.from.length <= 256));
    assert.ok(snap.threads.every((t) => t.with.length <= 256));
  });

  it('lists the newest received messages only, up to the cap', () => {
    const many = Array.from({ length: SNAPSHOT_MAIL_MAX + 5 }, (_, i) =>
      delivery(ME, 'bob', env({ id: `n${i}`, from: 'bob.desk.x', body: 'b' }), 600 - i),
    );
    const snap = buildSnapshot(input({ deliveries: many }));
    assert.equal(snap.mail.length, SNAPSHOT_MAIL_MAX);
    assert.equal(snap.mail.at(-1)?.id, `n${SNAPSHOT_MAIL_MAX + 4}`);
    assert.equal(snap.mail[0]?.id, 'n5');
  });

  it('first lines: the first non-blank line, one line, cut', () => {
    assert.equal(firstLine('\n\n  first\tx\nsecond'), 'first x');
    assert.equal(firstLine(''), '');
    assert.equal(firstLine('y'.repeat(500)).length, 200);
  });

  it('peers: self excluded, newest first, relation is the first that applies', () => {
    const peers = [
      peer(ME, { session: 'sess-me', lastSeen: NOW }),
      peer('alice.laptop.mgr-1', { lastSeen: NOW - 1 }),
      peer('alice.desk.child-1', { parent: 'alice.laptop.front', lastSeen: NOW - 2 }),
      peer('alice.desk.sib-1', { parent: 'alice.laptop.mgr-alias', lastSeen: NOW - 3 }),
      peer('bob.desk.repo-1', { repo: 'acme/web', lastSeen: NOW - 4 }),
      peer('bob.desk.talk-1', { lastSeen: NOW - 5 }),
      peer('bob.desk.svc-1', { lastSeen: NOW - 6 }),
      peer('alice.desk.mine-1', { lastSeen: NOW - 7 }),
      peer('carol.h.other-1', { lastSeen: NOW - 8, title: 'Carol work', offers: ['lang:ts'] }),
    ];
    peers[1]!.aliases = ['alice.laptop.mgr-alias'];
    const snap = buildSnapshot(
      input({
        state: state({ parent: 'alice.laptop.mgr-1', offers: ['lang:ts'] }),
        peers,
        claims: [
          {
            service: 'bob.help',
            holder: 'bob.desk.svc-1',
            session: 's-bob.desk.svc-1',
            at: null,
            lastSeen: NOW,
          },
        ],
        deliveries: [
          delivery(ME, 'bob', env({ id: 't1', from: 'bob.desk.talk-1', body: 'hi' }), 5),
        ],
        sent: [sent('bob.help', 3)],
      }),
    );
    assert.deepEqual(
      snap.peers.map((p) => [p.address, p.relation]),
      [
        ['alice.laptop.mgr-1', 'parent'],
        ['alice.desk.child-1', 'child'],
        ['alice.desk.sib-1', 'sibling'],
        ['bob.desk.repo-1', 'same-repo'],
        ['bob.desk.talk-1', 'correspondent'],
        ['bob.desk.svc-1', 'correspondent'],
        ['alice.desk.mine-1', 'mine'],
        ['carol.h.other-1', 'other'],
      ],
    );
    assert.deepEqual(snap.peers[5]?.services, ['bob.help']);
    assert.equal(snap.peers[7]?.title, 'Carol work');
    assert.deepEqual(snap.areas, [{ area: 'lang:ts', offeredBy: 2, isMine: true }]);
    assert.deepEqual(Object.keys(snap.peers[0] ?? {}), [
      'address',
      'aliases',
      'user',
      'host',
      'agent',
      'title',
      'status',
      'role',
      'parent',
      'repo',
      'branch',
      'offers',
      'services',
      'lastSeen',
      'relation',
    ]);
  });

  it('threads without mail are empty', () => {
    assert.deepEqual(buildThreads([], []), []);
  });
});

describe('title', () => {
  it('is checked exactly like a status: one printable line, at most 120 characters', () => {
    assert.equal(TITLE_MAX, 120);
    assert.equal(checkTitle('  Fix\nthe\u202elogin  '), 'Fix the login');
    assert.equal(checkTitle(''), null);
    assert.equal(checkTitle(42), null);
    assert.equal([...(checkTitle('t'.repeat(300)) ?? '')].length, 120);
  });
});

describe('sent log', () => {
  const tmpEnv = () => ({
    AGENT_MAILBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'amb-sent-')),
  });

  it('records kind and area from the recipient and cuts the body', () => {
    assert.equal(kindOf('all'), 'broadcast');
    assert.equal(kindOf('area:lang:ts'), 'ask');
    assert.equal(kindOf('bob.helpdesk'), 'service');
    assert.equal(kindOf('bob.desk.x'), 'direct');
    const r = sentRecord({
      id: 'i',
      to: 'area:lang:ts',
      subject: 's',
      body: 'z'.repeat(SENT_BODY_MAX + 1),
      inReplyTo: null,
      time: 5,
    });
    assert.deepEqual(
      { ...r, body: r.body.length },
      {
        id: 'i',
        to: 'area:lang:ts',
        kind: 'ask',
        area: 'lang:ts',
        subject: 's',
        body: SENT_BODY_MAX,
        isTruncated: true,
        inReplyTo: null,
        time: 5,
      },
    );
    // a surrogate pair is never split
    const cut = sentRecord({
      id: 'j',
      to: 'all',
      subject: null,
      body: 'a'.repeat(SENT_BODY_MAX - 1) + '😀',
      inReplyTo: null,
    });
    assert.equal(cut.body.length, SENT_BODY_MAX - 1);
  });

  it('appends (mode 0600), reads back oldest first, skips corrupt lines, tolerates a missing file', () => {
    const e = tmpEnv();
    assert.deepEqual(readSentLog('s1', e), []);
    appendSentLog('s1', sent('bob.desk.x', 2, { id: 'a' }), e);
    fs.appendFileSync(sentLogPath('s1', e), '{"half": \nnot json\n{"id":"x"}\n');
    appendSentLog('s1', sent('all', 1, { id: 'b' }), e);
    assert.deepEqual(
      readSentLog('s1', e).map((r) => r.id),
      ['a', 'b'],
    );
    assert.equal(fs.statSync(sentLogPath('s1', e)).mode & 0o777, 0o600);
    // A torn last record (a crash mid-append) costs only itself, not the next one.
    const file = sentLogPath('s1', e);
    fs.truncateSync(file, fs.statSync(file).size - 8);
    appendSentLog('s1', sent('all', 1, { id: 'c' }), e);
    assert.deepEqual(
      readSentLog('s1', e).map((r) => r.id),
      ['a', 'c'],
    );
    assert.equal(checkSentRecord({ id: 'q', to: 'all', body: 1, time: 1 }), null);
    assert.equal(checkSentRecord(null), null);
  });

  it('keeps the newest records once it grows past the compaction size', () => {
    const e = tmpEnv();
    for (let i = 0; i < 60; i++)
      appendSentLog('s2', sent('bob.desk.x', 0, { id: `n${i}` }), e, {
        compactBytes: 3000,
        keep: 5,
      });
    const ids = readSentLog('s2', e).map((r) => r.id);
    assert.ok(ids.length < 60 && ids.length > 0, `${ids.length} kept`);
    assert.equal(ids.at(-1), 'n59');
    assert.ok(!ids.includes('n0'));
    assert.equal(fs.statSync(sentLogPath('s2', e)).mode & 0o777, 0o600);
    assert.ok(SENT_KEEP >= 500);
  });
});
