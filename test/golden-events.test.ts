// Golden test: the exact bytes of an events-feed entry and the sharing list, read back from a real
// server (it needs nats-server, so it is skipped without one, like golden-presence). See
// test/golden.test.ts for why these tests exist.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { jetstreamManager } from '@nats-io/jetstream';
import { sessionEvent } from '../src/core/events.js';
import { createTransport, eventsStreamFor } from '../src/core/transport/nats.js';
import { Broker, findServer } from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('golden: events feed entry', { skip: SERVER.skip }, () => {
  let b: Broker;
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
    b.admin(['set-sharing', 'bob', 'private']);
  });
  after(() => b?.stop());

  it('an event is stored on evt.<user>.<host> in EVT_<USER> as exactly these fields, in this order', async () => {
    const t = createTransport({ servers: [b.url], user: 'alice', password: b.password('alice') });
    const nc = await b.conn('admin'); // the raw stored message, as the admin sees it
    try {
      const ev = sessionEvent(
        'status-changed',
        {
          address: 'alice.laptop.web-1a2b',
          aliases: ['alice.laptop.front'],
          cwd: '/work/web',
          createdAt: '2026-01-02T03:04:05.678Z',
          role: 'worker',
          parent: 'alice.laptop.mgr-9c8d',
          status: 'running the tests',
        },
        {
          cfg: { user: 'alice' },
          git: { repo: 'acme/web', branch: 'feat/login' },
          at: new Date('2026-10-17T12:00:00.000Z'),
        },
      );
      await t.events.publish(ev);
      assert.equal(eventsStreamFor('alice'), 'EVT_ALICE');
      assert.equal(eventsStreamFor('dev-ops'), 'EVT_DEV_OPS');
      const jsm = await jetstreamManager(nc);
      const m = await jsm.direct.getMessage('EVT_ALICE', { seq: 1 });
      assert.ok(m);
      assert.equal(m.subject, 'evt.alice.laptop');
      assert.equal(
        m.string(),
        '{"event":"status-changed","address":"alice.laptop.web-1a2b","user":"alice","host":"laptop","repo":"acme/web","branch":"feat/login","role":"worker","parent":"alice.laptop.mgr-9c8d","status":"running the tests","at":"2026-10-17T12:00:00.000Z"}',
      );
      // ...and the entry read back from it
      const [entry] = await t.events.read('alice', { sinceMs: 3600_000 });
      assert.ok(entry);
      assert.deepEqual(
        { ...entry, time: 0 },
        { ...ev, time: 0 },
        'read() returns the event as written, plus the server time',
      );
      // The sharing list: key "team" of bucket "sharing", a JSON array of user names.
      const list = await jsm.direct.getMessage('KV_sharing', { last_by_subj: '$KV.sharing.team' });
      assert.equal(list?.string(), '["alice"]');
      assert.deepEqual(await t.events.shared(), ['alice']);
    } finally {
      await t.close();
      await nc.close();
    }
  });
});
