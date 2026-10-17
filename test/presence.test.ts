// Presence lives in a KV bucket whose entries expire (bucket TTL). This suite provisions the
// bucket with a 4 s TTL so expiry can be observed (long enough that 500 ms heartbeats keep entries
// alive even when the machine stalls for a second or two).
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { Broker, Watcher, findServer, makeEnv, mbox, projectDir, sessionAddr, sleep, type MachineEnv } from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('presence', { skip: SERVER.skip }, () => {
  let b: Broker;
  let aliceEnv: MachineEnv;
  let bobEnv: MachineEnv;
  before(async () => {
    b = new Broker(SERVER, { presenceTtl: '4s' });
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
    bobEnv = makeEnv(b, 'bob');
  });
  after(() => b?.stop());
  const peers = (): string => {
    const r = mbox(['peers'], { env: aliceEnv });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  };

  it('peers lists live sessions; depart deletes the entry immediately', async () => {
    const d1 = projectDir('peer-one');
    const d2 = projectDir('peer-two');
    const a1 = sessionAddr(bobEnv, 'peersess-1', d1);
    const a2 = sessionAddr(bobEnv, 'peersess-2', d2);
    const env = { ...bobEnv, AGENT_MAILBOX_HEARTBEAT_MS: '500' }; // keeps the entries fresh despite the 4 s TTL
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
      await sleep(5000); // longer than the TTL: heartbeats keep both alive
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
    for (const t0 = Date.now(); Date.now() - t0 < 30000 && !gone; ) {
      await sleep(250);
      gone = !peers().includes(addr);
    }
    assert.ok(gone, 'entry expired');
  });
});
