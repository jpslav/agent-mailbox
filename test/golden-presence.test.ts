// Golden test: the exact bytes of a presence KV entry, and of a service claim stored in the same
// bucket, read back from a real server. Split from
// test/golden.test.ts because it needs nats-server (skipped without it); the other golden tests
// run in `npm run test:unit`. See that file for why these tests exist.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { Kvm } from '@nats-io/kv';
import { jetstream } from '@nats-io/jetstream';
import { presenceRecord } from '../src/core/registry.js';
import { claimService } from '../src/core/services.js';
import { createTransport, presenceKey } from '../src/core/transport/nats.js';
import { Broker, findServer } from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('golden: presence KV entry', { skip: SERVER.skip }, () => {
  let b: Broker;
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice']);
  });
  after(() => b?.stop());

  // 0.5.6 added repo, branch, role, parent and status after pid (#15), 0.6.1 offers after status
  // (#18), 0.8.0 title after offers; older readers ignore them (test/upgrade.test.ts).
  it('the stored value is the presence record plus "at", under key <user>.<host>.<12 hex of sha256(session)>', async () => {
    const t = createTransport({ servers: [b.url], user: 'alice', password: b.password('alice') });
    const nc = await b.conn('admin'); // a user may not read raw KV entries; the test inspects them as the admin
    try {
      const rec = presenceRecord(
        {
          address: 'alice.laptop.web-1a2b',
          aliases: ['alice.laptop.front'],
          cwd: '/work/web',
          createdAt: '2026-01-02T03:04:05.678Z',
          role: 'worker',
          parent: 'alice.laptop.mgr-9c8d',
          status: 'running the tests',
          offers: ['repo:github.com/acme/web', 'lang:ts'],
          title: 'Fix the login page',
        },
        {
          sid: 'sess-1',
          cfg: { user: 'alice' },
          agent: 'claude-code',
          pid: 4242,
          git: { repo: 'acme/web', branch: 'feat/login' },
        },
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
        `{"address":"alice.laptop.web-1a2b","aliases":["alice.laptop.front"],"session":"sess-1","agent":"claude-code","user":"alice","host":"laptop","cwd":"/work/web","pid":4242,"repo":"acme/web","branch":"feat/login","role":"worker","parent":"alice.laptop.mgr-9c8d","status":"running the tests","offers":["lang:ts","repo:github.com/acme/web"],"title":"Fix the login page","at":"${at[1]}"}`,
      );
      // ...and the listing built from it
      const [peer] = await t.presence.list();
      assert.ok(peer);
      assert.deepEqual(Object.keys(peer), [
        'session',
        'address',
        'aliases',
        'agent',
        'user',
        'host',
        'cwd',
        'pid',
        'repo',
        'branch',
        'role',
        'parent',
        'status',
        'offers',
        'title',
        'lastSeen',
        'live',
      ]);
      assert.deepEqual(
        { ...peer, lastSeen: 0 },
        {
          session: 'sess-1',
          address: 'alice.laptop.web-1a2b',
          aliases: ['alice.laptop.front'],
          agent: 'claude-code',
          user: 'alice',
          host: 'laptop',
          cwd: '/work/web',
          pid: 4242,
          repo: 'acme/web',
          branch: 'feat/login',
          role: 'worker',
          parent: 'alice.laptop.mgr-9c8d',
          status: 'running the tests',
          offers: ['lang:ts', 'repo:github.com/acme/web'],
          title: 'Fix the login page',
          lastSeen: 0,
          live: true,
        },
      );
    } finally {
      await t.close();
      await nc.close();
    }
  });

  // 0.7.0 (#19). No `address` field, so presence readers (this one and every earlier one) skip it.
  it('a service claim is {service, holder, session, at} under key <user>._svc.<name>, and no peer', async () => {
    const t = createTransport({ servers: [b.url], user: 'alice', password: b.password('alice') });
    const nc = await b.conn('admin');
    try {
      const peersBefore = (await t.presence.list()).length;
      const res = await claimService(
        t.services,
        { service: 'alice.helpdesk', holder: 'alice.laptop.web-1a2b', session: 'sess-1' },
        { isLive: () => true },
      );
      assert.deepEqual(res, { status: 'claimed', replaced: null });
      const kv = await new Kvm(jetstream(nc)).open('presence');
      const raw = (await kv.get('alice._svc.helpdesk'))?.string();
      assert.ok(raw);
      const at = raw.match(/"at":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"\}$/);
      assert.ok(at, raw);
      assert.equal(
        raw,
        `{"service":"alice.helpdesk","holder":"alice.laptop.web-1a2b","session":"sess-1","at":"${at[1]}"}`,
      );
      // ...the claim as read back, and the listing: the claim, never a peer
      const { claim, version } = await t.services.read('alice.helpdesk');
      assert.ok(version > 0);
      assert.deepEqual(Object.keys(claim ?? {}), [
        'service',
        'holder',
        'session',
        'at',
        'lastSeen',
      ]);
      assert.deepEqual(
        { ...claim, lastSeen: 0 },
        {
          service: 'alice.helpdesk',
          holder: 'alice.laptop.web-1a2b',
          session: 'sess-1',
          at: at[1],
          lastSeen: 0,
        },
      );
      assert.deepEqual(
        (await t.services.list()).map((c) => c.service),
        ['alice.helpdesk'],
      );
      assert.equal((await t.presence.list()).length, peersBefore, 'the claim was listed as a peer');
    } finally {
      await t.close();
      await nc.close();
    }
  });
});
