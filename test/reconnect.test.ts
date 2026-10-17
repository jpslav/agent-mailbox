import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { Broker, Watcher, findServer, makeEnv, projectDir, send, sessionAddr, sleep } from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('server crash and restart', { skip: SERVER.skip }, () => {
  let b: Broker;
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
  });
  after(() => b?.stop());

  it('kill -9 + restart (file storage): queued and new mail still arrive; one lost line, one restored line', async () => {
    const aliceEnv = makeEnv(b, 'alice');
    const bobEnv = makeEnv(b, 'bob');
    const dir = projectDir('recon');
    const addr = sessionAddr(bobEnv, 'reconsess', dir);
    const away = sessionAddr(bobEnv, 'awaysess', projectDir('away')); // a session nobody is watching
    const w = new Watcher(bobEnv, { cwd: dir, session: 'reconsess' });
    let w2: Watcher | undefined;
    try {
      await w.waitFor(/online as/);
      assert.equal(send(aliceEnv, 'alicesess-r', dir, addr, 'before').code, 0);
      await w.waitFor(/before/);
      assert.equal(send(aliceEnv, 'alicesess-r', dir, away, 'queued before the crash').code, 0);

      await b.kill(); // SIGKILL: no clean shutdown, no flush beyond what sync_interval: always did
      await w.waitFor(/\[mailbox\] connection lost; retrying\n/);
      await sleep(4500); // several failed retries: must stay silent
      await b.start();
      await w.waitFor(/\[mailbox\] connection restored\n/, 60000); // server recovery time depends on the machine

      assert.equal(send(aliceEnv, 'alicesess-r', dir, addr, 'after').code, 0);
      await w.waitFor(/after/, 30000);
      w2 = new Watcher(bobEnv, { cwd: dir, session: 'awaysess' });
      await w2.waitFor(/queued before the crash/, 30000);
      await sleep(800);
      assert.equal(w.out.split('connection lost').length - 1, 1, w.out);
      assert.equal(w.out.split('connection restored').length - 1, 1, w.out);
      assert.deepEqual(w.messages().map((m) => m.body), ['before', 'after']);
      assert.deepEqual(w2.messages().map((m) => m.body), ['queued before the crash']);
    } finally {
      await w.stop();
      await w2?.stop();
    }
  });
});
