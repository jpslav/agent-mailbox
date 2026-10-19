// `mbox snapshot --json`, `mbox title` and the sent log against a real server: what a side panel
// reads with one process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before } from 'node:test';
import type { Snapshot } from '../src/core/types.js';
import {
  Broker,
  Watcher,
  findServer,
  makeEnv,
  mbox,
  parseJson,
  projectDir,
  send,
  sessionAddr,
  sleep,
  type MachineEnv,
} from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('snapshot and titles', { skip: SERVER.skip }, () => {
  let b: Broker;
  let aliceEnv: MachineEnv;
  let bobEnv: MachineEnv;
  const watchers: Watcher[] = [];
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
    bobEnv = makeEnv(b, 'bob');
  });
  after(async () => {
    await Promise.all(watchers.map((w) => w.stop().catch(() => {})));
    await b?.stop();
  });

  const run = (env: MachineEnv, session: string, cwd: string, args: string[]) =>
    mbox(args, { env: { ...env, AGENT_MAILBOX_SESSION: session }, cwd });

  it('title: set, shown in whoami and peers, cleared; checked like a status', async () => {
    const dir = projectDir('title-bob');
    const w = new Watcher(bobEnv, { cwd: dir, session: 'tb' });
    watchers.push(w);
    const [, addr = ''] = await w.waitFor(/online as ([a-z0-9.-]*[a-z0-9])/);
    assert.equal(run(bobEnv, 'tb', dir, ['title']).stdout.trim(), '(no title)');
    const set = run(bobEnv, 'tb', dir, ['title', 'Fix the\nlogin page']);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(set.stdout.trim(), 'Fix the login page');
    assert.match(run(bobEnv, 'tb', dir, ['whoami']).stdout, /^title: Fix the login page$/m);
    const row = (): string =>
      mbox(['peers'], { env: aliceEnv })
        .stdout.split('\n')
        .find((l) => l.includes(addr)) ?? '';
    assert.match(
      mbox(['peers'], { env: aliceEnv }).stdout,
      /ADDRESS\s+ALIASES\s+AGENT\s+USER@HOST\s+TITLE\s+ROLE\s+REPO/,
    );
    assert.match(row(), /bob@\S+\s+Fix the login page\s+-\s/);
    const long = run(bobEnv, 'tb', dir, ['title', 'x'.repeat(121)]);
    assert.equal(long.code, 2);
    assert.match(long.stderr, /title is 121 characters; the limit is 120/);
    assert.equal(run(bobEnv, 'tb', dir, ['title', '--clear']).stdout.trim(), '(no title)');
    for (let t0 = Date.now(); Date.now() - t0 < 20000 && !/bob@\S+\s+-\s/.test(row());)
      await sleep(200);
    assert.match(row(), /bob@\S+\s+-\s/);
  });

  it('snapshot --json: self, peers with relation and title, mail, sent log, threads, areas', async () => {
    const bobDir = projectDir('snap-bob');
    const aliceDir = projectDir('snap-alice');
    const w = new Watcher(bobEnv, { cwd: bobDir, session: 'sb' });
    watchers.push(w);
    const [, bobAddr = ''] = await w.waitFor(/online as ([a-z0-9.-]*[a-z0-9])/);
    assert.equal(run(bobEnv, 'sb', bobDir, ['title', 'Bob reviews']).code, 0);
    assert.equal(run(bobEnv, 'sb', bobDir, ['offer', 'lang:ts']).code, 0);
    const aliceAddr = sessionAddr(aliceEnv, 'sa', aliceDir);
    assert.equal(run(aliceEnv, 'sa', aliceDir, ['title', 'Alice builds']).code, 0);

    // bob -> alice, alice answers, alice asks in bob's area
    const first = send(bobEnv, 'sb', bobDir, aliceAddr, 'please review\nthe diff', [
      '--subject',
      'review',
    ]);
    assert.equal(first.code, 0, first.stderr);
    const firstId = first.stdout.trim();
    const reply = send(aliceEnv, 'sa', aliceDir, bobAddr, 'done', ['--re', firstId]);
    assert.equal(reply.code, 0, reply.stderr);
    const ask = run(aliceEnv, 'sa', aliceDir, ['ask', 'lang:ts', 'how?']);
    assert.equal(ask.code, 0, ask.stderr);
    await w.waitFor(/how\?/, 30000);

    const sentLog = path.join(aliceEnv.AGENT_MAILBOX_STATE_DIR, 'sessions', 'sa.sent.jsonl');
    assert.equal(fs.statSync(sentLog).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(sentLog, 'utf8').trim().split('\n').length, 2);

    const r = run(aliceEnv, 'sa', aliceDir, ['snapshot', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const snap = parseJson<Snapshot>(r.stdout);
    assert.equal(snap.v, 1);
    assert.equal(snap.since, '24h');
    assert.equal(snap.socket, null);
    assert.equal(snap.self.address, aliceAddr);
    assert.equal(snap.self.title, 'Alice builds');
    const bob = snap.peers.find((p) => p.address === bobAddr);
    assert.ok(bob, JSON.stringify(snap.peers));
    assert.equal(bob.title, 'Bob reviews');
    assert.equal(bob.relation, 'correspondent');
    assert.ok(!snap.peers.some((p) => p.address === aliceAddr), 'self is not a peer');
    assert.deepEqual(
      snap.mail.map((m) => [m.id, m.kind, m.from, m.subject, m.body, m.verifiedUser]),
      [[firstId, 'direct', bobAddr, 'review', 'please review\nthe diff', 'bob']],
    );
    assert.deepEqual(
      snap.sent.map((s) => [s.id, s.kind, s.to, s.area, s.inReplyTo]),
      [
        [reply.stdout.trim(), 'direct', bobAddr, null, firstId],
        [ask.stdout.trim(), 'ask', 'area:lang:ts', 'lang:ts', null],
      ],
    );
    assert.deepEqual(
      snap.threads.map((t) => [t.with, t.kind, t.count, t.isAwaitingMe]),
      [
        ['area:lang:ts', 'ask', 1, false],
        [bobAddr, 'direct', 2, false],
      ],
    );
    assert.equal(snap.threads[1]?.messages[0]?.firstLine, 'please review');
    assert.deepEqual(snap.areas, [{ area: 'lang:ts', offeredBy: 1, isMine: false }]);

    // --since narrows; without --json it refuses
    const narrow = parseJson<Snapshot>(
      run(aliceEnv, 'sa', aliceDir, ['snapshot', '--json', '--since', '1s']).stdout,
    );
    assert.equal(narrow.since, '1s');
    const plain = run(aliceEnv, 'sa', aliceDir, ['snapshot']);
    assert.equal(plain.code, 2);
    assert.match(plain.stderr, /--json/);
  });
});
