// Presence lives in a KV bucket whose entries expire (bucket TTL). This suite provisions the
// bucket with a 4 s TTL so expiry can be observed (long enough that 500 ms heartbeats keep entries
// alive even when the machine stalls for a second or two).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import {
  Broker,
  Watcher,
  findServer,
  makeEnv,
  mbox,
  projectDir,
  sessionAddr,
  sleep,
  type MachineEnv,
} from './helpers.js';
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
      assert.match(
        list,
        /ADDRESS\s+ALIASES\s+AGENT\s+USER@HOST\s+ROLE\s+REPO\s+BRANCH\s+STATUS\s+OFFERS\s+SERVICES\s+CWD\s+LAST SEEN/,
      );
      assert.ok(list.includes(a1) && list.includes(a2), list);
      assert.match(list, /claude-code\s+bob@/);
      const amb = mbox(['send', 'peer-', 'x'], {
        env: { ...aliceEnv, AGENT_MAILBOX_SESSION: 'alicesess-6' },
        cwd: d1,
      });
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
    for (const t0 = Date.now(); Date.now() - t0 < 30000 && !gone;) {
      await sleep(250);
      gone = !peers().includes(addr);
    }
    assert.ok(gone, 'entry expired');
  });

  it('metadata: repo and branch from git, role and parent from the spawner, status live; peers --tree', async () => {
    // A checkout as git leaves it on disk (no git process is needed to read it).
    const mgrDir = projectDir('meta-mgr');
    fs.mkdirSync(path.join(mgrDir, '.git'));
    const head = path.join(mgrDir, '.git', 'HEAD');
    fs.writeFileSync(head, 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(mgrDir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    );
    const env = { ...bobEnv, AGENT_MAILBOX_HEARTBEAT_MS: '500' };
    const mgr = new Watcher(
      { ...env, AGENT_MAILBOX_ROLE: 'manager' },
      { cwd: mgrDir, session: 'metamgr' },
    );
    const workers: Watcher[] = [];
    try {
      const [, mgrAddr = ''] = await mgr.waitFor(/online as ([a-z0-9.-]*[a-z0-9])/);
      const row = (addr: string, out = peers()): string =>
        out.split('\n').find((l) => l.includes(addr)) ?? '';
      const until = async (what: string, ok: () => boolean): Promise<void> => {
        for (const t0 = Date.now(); Date.now() - t0 < 30000; await sleep(200)) if (ok()) return;
        assert.fail(`timed out: ${what}\n${peers()}`);
      };
      assert.match(row(mgrAddr), /\bmanager\s+acme\/widgets\s+main\s+-\s/);

      // A worker spawned with the manager's address as its parent.
      const wDir = projectDir('meta-worker');
      const w = new Watcher(
        { ...env, AGENT_MAILBOX_ROLE: 'worker', AGENT_MAILBOX_PARENT: mgrAddr },
        { cwd: wDir, session: 'metaworker' },
      );
      workers.push(w);
      const [, wAddr = ''] = await w.waitFor(/online as ([a-z0-9.-]*[a-z0-9])/);
      // An orphan: its parent is not live.
      const o = new Watcher(
        { ...env, AGENT_MAILBOX_PARENT: 'bob.elsewhere.gone-1' },
        { cwd: projectDir('meta-orphan'), session: 'metaorphan' },
      );
      workers.push(o);
      const [, oAddr = ''] = await o.waitFor(/online as ([a-z0-9.-]*[a-z0-9])/);
      const tree = mbox(['peers', '--tree'], { env: aliceEnv });
      assert.equal(tree.code, 0, tree.stderr);
      const lines = tree.stdout.split('\n');
      const at = (s: string): number => lines.findIndex((l) => l.includes(s));
      assert.ok(at(mgrAddr) > 0 && at(`└─ ${wAddr}`) === at(mgrAddr) + 1, tree.stdout);
      assert.match(lines[at(wAddr)] ?? '', /\bworker\s+-\s+-\s/);
      assert.ok(
        lines[at(oAddr)]?.startsWith(`${oAddr} (parent not live: bob.elsewhere.gone-1)`),
        tree.stdout,
      );

      // mbox status shows at once (presence update), and survives later heartbeats: change the
      // branch and wait until peers shows it, which needs a heartbeat sent after the status.
      const st = mbox(['status', 'running the tests'], {
        env: { ...env, AGENT_MAILBOX_SESSION: 'metamgr' },
        cwd: mgrDir,
      });
      assert.equal(st.code, 0, st.stderr);
      // Shown by the command's own presence update, and kept by every later heartbeat; either way
      // a condition to wait for, not a moment to assert on.
      await until('the status', () => /\bmain\s+running the tests\s/.test(row(mgrAddr)));
      fs.writeFileSync(head, 'ref: refs/heads/feat/x\n');
      await until('the new branch', () => /\bfeat\/x\s/.test(row(mgrAddr)));
      // A heartbeat sent after the status still carries it (each heartbeat re-reads the state).
      assert.match(row(mgrAddr), /\bfeat\/x\s+running the tests\s/);

      // whoami --role / --parent change it live too; none clears.
      const who = mbox(['whoami', '--role', 'worker', '--parent', oAddr], {
        env: { ...env, AGENT_MAILBOX_SESSION: 'metamgr' },
        cwd: mgrDir,
      });
      assert.equal(who.code, 0, who.stderr);
      assert.deepEqual(who.stdout.trim().split('\n'), [
        mgrAddr,
        'role: worker',
        `parent: ${oAddr}`,
        'status: running the tests',
      ]);
      await until('the new role', () => /\bworker\s+acme\/widgets/.test(row(mgrAddr)));
      const cleared = mbox(['status', '--clear'], {
        env: { ...env, AGENT_MAILBOX_SESSION: 'metamgr' },
        cwd: mgrDir,
      });
      assert.equal(cleared.code, 0, cleared.stderr);
      await until('the cleared status', () => /\bfeat\/x\s+-\s/.test(row(mgrAddr)));
      const self = mbox(['whoami', '--parent', mgrAddr], {
        env: { ...env, AGENT_MAILBOX_SESSION: 'metamgr' },
        cwd: mgrDir,
      });
      assert.equal(self.code, 2);
      assert.match(self.stderr, /cannot be its own parent/);
      const tooLong = mbox(['status', 'x'.repeat(121)], {
        env: { ...env, AGENT_MAILBOX_SESSION: 'metamgr' },
        cwd: mgrDir,
      });
      assert.equal(tooLong.code, 2);
      assert.match(tooLong.stderr, /limit is 120/);
    } finally {
      await Promise.all([mgr.stop(), ...workers.map((w) => w.stop())]);
    }
  });
});
