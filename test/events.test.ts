// The events feed end to end: hooks and commands write events, `mbox events` reads them across
// users as the admin's sharing settings allow. The permission boundary itself is proved in
// test/isolation.test.ts; this suite checks what the client does with it.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { jetstream } from '@nats-io/jetstream';
import {
  Broker,
  findServer,
  makeEnv,
  mbox,
  parseJson,
  projectDir,
  type MachineEnv,
} from './helpers.js';
import { describe, it } from './suite.js';
import type { FeedEntry } from '../src/core/types.js';

const SERVER = findServer();

describe('events feed', { skip: SERVER.skip }, () => {
  let b: Broker;
  let alice: MachineEnv;
  let bob: MachineEnv;
  let carol: MachineEnv;
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob', 'carol']);
    b.admin(['set-sharing', 'carol', 'private']);
    alice = makeEnv(b, 'alice');
    bob = makeEnv(b, 'bob');
    carol = makeEnv(b, 'carol');
  });
  after(() => b?.stop());

  /** Run mbox as `env`'s user in session `session`; it must succeed. */
  const run = (env: MachineEnv, session: string, args: string[], cwd?: string): string => {
    const r = mbox(args, { env: { ...env, AGENT_MAILBOX_SESSION: session }, cwd });
    assert.equal(r.code, 0, `mbox ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  /** `mbox events --json <args>` as `env`'s user. */
  const feed = (env: MachineEnv, args: string[] = []): FeedEntry[] => {
    const r = mbox(['events', '--json', '--limit', '1000', ...args], { env });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => parseJson<FeedEntry>(l));
  };
  const hook = (env: MachineEnv, event: string, input: object): void => {
    const r = mbox(['hook', 'claude-code', event], { env, input: JSON.stringify(input) });
    assert.equal(r.code, 0, r.stderr);
  };

  it('session-start writes started (not on a compaction); session-end writes ended', () => {
    const cwd = projectDir('hooked');
    const input = { session_id: 'ev-hook-1', cwd, hook_event_name: 'SessionStart' };
    hook(alice, 'session-start', { ...input, source: 'startup' });
    hook(alice, 'session-start', { ...input, source: 'compact' });
    hook(alice, 'session-start', { ...input, source: 'resume' });
    hook(alice, 'session-end', { session_id: 'ev-hook-1', hook_event_name: 'SessionEnd' });
    const mine = feed(alice).filter((e) => /\.hooked-/.test(e.address));
    assert.deepEqual(
      mine.map((e) => e.event),
      ['started', 'started', 'ended'],
    );
    assert.ok(mine.every((e) => e.user === 'alice' && e.address.startsWith('alice.')));
  });

  it('status, role, parent and done write events, each only on a change', () => {
    const cwd = projectDir('worker');
    const s = 'ev-cmd-1';
    run(alice, s, ['status', 'building'], cwd);
    run(alice, s, ['status', 'building'], cwd); // unchanged: no event
    run(alice, s, ['whoami', '--role', 'worker', '--parent', 'bob.box.mgr-1'], cwd);
    run(alice, s, ['whoami', '--role', 'worker'], cwd); // unchanged: no event
    run(alice, s, ['status', '--clear'], cwd);
    assert.equal(run(alice, s, ['done', 'merged the fix'], cwd).trim(), 'merged the fix');
    const mine = feed(alice).filter((e) => /\.worker-/.test(e.address));
    assert.deepEqual(
      mine.map((e) => [e.event, e.status, e.role, e.parent]),
      [
        ['status-changed', 'building', null, null],
        ['role-changed', 'building', 'worker', 'bob.box.mgr-1'],
        ['parent-changed', 'building', 'worker', 'bob.box.mgr-1'],
        ['status-changed', null, 'worker', 'bob.box.mgr-1'],
        ['done', 'merged the fix', 'worker', 'bob.box.mgr-1'],
      ],
    );
    const done = mine.at(-1)!; // five entries, checked above
    assert.deepEqual(Object.keys(done), [
      'event',
      'address',
      'user',
      'host',
      'repo',
      'branch',
      'role',
      'parent',
      'status',
      'at',
      'time',
    ]);
    assert.equal(done.host, done.address.split('.')[1]);
    assert.ok(Math.abs(Date.parse(done.at) - done.time) < 60000);
    assert.notEqual(mbox(['done', ''], { env: { ...alice, AGENT_MAILBOX_SESSION: s } }).code, 0);
  });

  it('never carries message contents', () => {
    const s = 'ev-mail-1';
    run(alice, s, ['send', 'bob.box.x', 'the secret body 7f3a'], projectDir('mailer'));
    run(alice, s, ['status', 'mailed'], projectDir('mailer'));
    const r = mbox(['events', '--json', '--since', '1h'], { env: alice });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"status":"mailed"/);
    assert.doesNotMatch(r.stdout, /7f3a/);
  });

  it("reads a colleague's feed only when it is shared; --all reads every shared feed", () => {
    run(bob, 'ev-bob-1', ['status', 'reviewing'], projectDir('bobwork'));
    run(carol, 'ev-carol-1', ['status', 'private work'], projectDir('carolwork'));

    const fromBob = feed(alice, ['--user', 'bob']);
    assert.ok(fromBob.some((e) => e.status === 'reviewing' && e.user === 'bob'));
    const denied = mbox(['events', '--user', 'carol'], { env: alice });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /carol's events feed is not shared with you/);
    const nobody = mbox(['events', '--user', 'nobody'], { env: alice });
    assert.equal(nobody.code, 1);
    assert.match(nobody.stderr, /not shared with you \(it is private, or there is no such user\)/);

    const all = feed(alice, ['--all']);
    assert.deepEqual([...new Set(all.map((e) => e.user))].sort(), ['alice', 'bob']);
    const sorted = [...all].sort((x, y) => x.time - y.time);
    assert.deepEqual(all, sorted);
    // carol, private, still reads her own feed and the shared ones.
    assert.ok(feed(carol).some((e) => e.status === 'private work'));
    assert.deepEqual([...new Set(feed(carol, ['--all']).map((e) => e.user))].sort(), [
      'alice',
      'bob',
      'carol',
    ]);
  });

  it('--sharing tells a user how their feed is shared', () => {
    const a = mbox(['events', '--sharing'], { env: alice });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /your feed: team/);
    assert.match(a.stdout, /shared with the team: bob\n/);
    const c = mbox(['events', '--sharing'], { env: carol });
    assert.match(c.stdout, /your feed: private \(only you can read it\)/);
    assert.match(c.stdout, /shared with the team: alice, bob\n/);
    const d = mbox(['doctor'], { env: carol });
    assert.match(d.stdout, /ok {4}own events feed EVT_CAROL is readable/);
    assert.match(d.stdout, /ok {4}events feed sharing: private/);
  });

  it('drops entries that are not events or name another user, and shows the rest as a table', async () => {
    const nc = await b.conn('alice');
    try {
      const js = jetstream(nc, { checkAPI: false });
      await js.publish('evt.alice.box', 'not json');
      await js.publish(
        'evt.alice.box',
        JSON.stringify({ event: 'done', address: 'bob.box.forged', status: 'forged' }),
      );
      await js.publish(
        'evt.alice.box',
        JSON.stringify({ event: 'exploded', address: 'alice.box.odd', status: 'odd' }),
      );
      await js.publish(
        'evt.alice.box',
        JSON.stringify({
          event: 'done',
          address: 'alice.box.raw',
          role: 'boss',
          status: 'x\u001b[31mred',
          repo: 'no slash',
          at: 'yesterday',
        }),
      );
    } finally {
      await nc.close();
    }
    const entries = feed(bob, ['--user', 'alice']);
    assert.ok(!entries.some((e) => e.status === 'forged' || e.status === 'odd'));
    const raw = entries.find((e) => e.address === 'alice.box.raw');
    assert.ok(raw);
    assert.deepEqual([raw.role, raw.status, raw.repo], [null, 'x [31mred', null]);
    assert.equal(raw.at, new Date(raw.time).toISOString());

    const table = mbox(['events', '--user', 'alice', '--limit', '2'], { env: bob });
    assert.equal(table.code, 0, table.stderr);
    const lines = table.stdout.trim().split('\n');
    assert.match(lines[0] ?? '', /^\(\d+ older events not shown; --limit\)$/);
    assert.match(
      lines[1] ?? '',
      /^TIME\s+EVENT\s+ADDRESS\s+ROLE\s+REPO\s+BRANCH\s+PARENT\s+STATUS$/,
    );
    assert.equal(lines.length, 4);
    assert.match(lines[3] ?? '', /done\s+alice\.box\.raw/);
  });

  it('rejects bad options', () => {
    for (const args of [
      ['--user', 'bob', '--all'],
      ['--user', 'Bob'],
      ['--since', '3w'],
      ['--limit', '0'],
    ]) {
      const r = mbox(['events', ...args], { env: alice });
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    }
  });

  it('a feed that cannot be written never fails the command', () => {
    const env = { ...alice, AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9' }; // nothing listens there
    const r = mbox(['status', 'offline work'], {
      env: { ...env, AGENT_MAILBOX_SESSION: 'ev-off-1' },
      cwd: projectDir('offline'),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'offline work');
    assert.match(r.stderr, /could not write the "status-changed" event to your events feed/);
  });
});
