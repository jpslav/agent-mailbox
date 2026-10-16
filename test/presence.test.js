// Presence lives in a KV bucket whose entries expire (bucket TTL). This suite provisions the
// bucket with a 2 s TTL so expiry can be observed.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Broker, Watcher, findServer, makeEnv, mbox, projectDir, sessionAddr, sleep } from './helpers.js';

const SERVER = findServer();

describe('presence', { skip: SERVER.skip }, () => {
  let b;
  let aliceEnv;
  let bobEnv;
  before(async () => {
    b = new Broker(SERVER, { presenceTtl: '2s' });
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
    bobEnv = makeEnv(b, 'bob');
  });
  after(() => b?.stop());
  const peers = () => {
    const r = mbox(['peers'], { env: aliceEnv });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  };

  it('peers lists live sessions; depart deletes the entry immediately', async () => {
    const d1 = projectDir('peer-one');
    const d2 = projectDir('peer-two');
    const a1 = sessionAddr(bobEnv, 'peersess-1', d1);
    const a2 = sessionAddr(bobEnv, 'peersess-2', d2);
    const env = { ...bobEnv, AGENT_MAILBOX_HEARTBEAT_MS: '500' }; // keeps the entries fresh despite the 2 s TTL
    const w1 = new Watcher(env, { cwd: d1, session: 'peersess-1' });
    const w2 = new Watcher(env, { cwd: d2, session: 'peersess-2' });
    try {
      await Promise.all([w1.waitFor(/online as/), w2.waitFor(/online as/)]);
      const list = peers();
      assert.match(list, /ADDRESS\s+ALIASES\s+AGENT\s+USER@HOST\s+CWD\s+LAST SEEN/);
      assert.ok(list.includes(a1) && list.includes(a2), list);
      assert.match(list, /claude-code\s+bob@/);
      const amb = mbox(['send', 'peer-', 'x'], { env: { ...aliceEnv, AGENT_MAILBOX_SESSION: 'alicesess-6' }, cwd: d1 });
      assert.notEqual(amb.code, 0);
      assert.match(amb.stderr, /ambiguous/);
      assert.ok(amb.stderr.includes(a1) && amb.stderr.includes(a2), amb.stderr);
      await sleep(3000); // longer than the TTL: heartbeats keep both alive
      assert.ok(peers().includes(a1));
      await w2.stop(); // SIGTERM -> depart
      const after = peers();
      assert.ok(after.includes(a1) && !after.includes(a2), after);
    } finally {
      await w1.stop();
      await w2.stop();
    }
  });

  it('an entry that is not refreshed expires (bucket TTL)', async () => {
    const dir = projectDir('expire');
    const addr = sessionAddr(bobEnv, 'expiresess', dir);
    const w = new Watcher(bobEnv, { cwd: dir, session: 'expiresess' }); // default 10 min heartbeat
    await w.waitFor(/online as/);
    assert.ok(peers().includes(addr));
    w.proc.kill('SIGKILL'); // no depart
    await w.exited;
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = !peers().includes(addr);
    }
    assert.ok(gone, 'entry expired');
  });
});
