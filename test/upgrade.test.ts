// Upgrading a server provisioned by an earlier mbox-admin.sh (one account holding every user) to
// per-user accounts, against real nats-servers: mail and positions survive, clients already
// deployed keep working unchanged, an interrupted upgrade can be re-run and rolled back. Plus the
// nats-server behaviour the script works around (a new account's imports need a second reload).
// The earlier releases come from git (`fromRelease`); a clone without their tags skips those suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  ADMIN,
  Broker,
  Watcher,
  findServer,
  fromRelease,
  makeEnv,
  mbox,
  projectDir,
  sleep,
  type MachineEnv,
} from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();
const OLD_ADMIN = fromRelease('v0.5.7', 'server/mbox-admin.sh');
const BUNDLE = 'adapters/claude-code/dist/mbox.mjs';
const OLD_CLIENTS = [
  ['0.5.6', fromRelease('v0.5.6', BUNDLE)],
  ['0.5.7', fromRelease('v0.5.7', BUNDLE)],
] as const;
const skip =
  SERVER.skip ?? OLD_ADMIN.skip ?? OLD_CLIENTS.map(([, c]) => c.skip).find((s) => s !== undefined);

/** Poll `f` until it returns true (no timing assertions: only an upper bound). */
async function until(what: string, f: () => Promise<boolean> | boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Does `user` reach the stream account's API (through their imports, once upgraded)? */
async function reachesStreams(b: Broker, user: string): Promise<'ok' | 'auth' | 'no answer'> {
  let nc: NatsConnection;
  try {
    nc = await connect({
      servers: b.url,
      user,
      pass: b.password(user),
      inboxPrefix: `_INBOX_${user}`,
      reconnect: false,
      timeout: 3000,
    });
  } catch {
    return 'auth';
  }
  try {
    const r = await nc.request('$JS.API.INFO', '', { timeout: 2000 });
    return /account_info_response/.test(r.string()) ? 'ok' : 'no answer';
  } catch {
    return 'no answer';
  } finally {
    await nc.close();
  }
}

/**
 * The reply-subject injection: alice stores a forged envelope in her own stream and asks for it
 * back with bob's mail subject, signed by carol, as the reply. Returns whether MBX_BOB stored it.
 */
async function injectAsAlice(b: Broker, tag: string): Promise<boolean> {
  const alice = await b.conn('alice');
  const admin = await b.conn('admin');
  try {
    const jsm = await jetstreamManager(admin);
    const before = (await jsm.streams.info('MBX_BOB')).state.last_seq;
    const pa = await jetstream(alice, { checkAPI: false }).publish(
      `mbx.alice.h.inj.alice`,
      JSON.stringify({ v: 1, id: tag, from: 'carol.h.x', to: 'bob.forged.l', body: 'spoof' }),
    );
    alice.publish('$JS.API.DIRECT.GET.MBX_ALICE', JSON.stringify({ seq: pa.seq }), {
      reply: 'mbx.bob.forged.l.carol', // no session of bob's listens to this address
    });
    await alice.flush();
    await sleep(1500);
    const info = await jsm.streams.info('MBX_BOB');
    if (info.state.last_seq === before) return false;
    const m = await jsm.streams.getMessage('MBX_BOB', { seq: info.state.last_seq });
    return m?.subject === 'mbx.bob.forged.l.carol';
  } finally {
    await alice.close();
    await admin.close();
  }
}

/** A users.d file of the current layout for `user`, with a bcrypt hash of `password`. */
function writeUser(b: Broker, user: string, password: string): void {
  const r = spawnSync(SERVER.natsBin, ['server', 'passwd'], {
    env: { ...process.env, PASSWORD: password },
    encoding: 'utf8',
    input: '',
  });
  const hash = r.stdout.trim();
  assert.match(hash, /^\$2[aby]?\$\d\d\$/, r.stderr);
  fs.writeFileSync(
    path.join(b.confDir, 'users.d', `${user}.conf`),
    `  {\n    user: "${user}"\n    password: "${hash}"\n  }\n`,
    { mode: 0o600 },
  );
  b.passwords[user] = password;
}

describe('nats-server reload behaviour', { skip: SERVER.skip }, () => {
  const brokers: Broker[] = [];
  after(async () => {
    for (const b of brokers) await b.stop();
  });

  // mbox-admin.sh reloads twice because of this (docs/DECISIONS.md). This test fails as soon as
  // one reload is enough (then the second can go) or two are not (then the script must change).
  it("a reload that adds an account wires that account's imports only on the next reload", async () => {
    const b = new Broker(SERVER);
    brokers.push(b);
    await b.init(['alice']);
    writeUser(b, 'dave', 'dave-password-123456');
    // regenerate users.conf without reloading: a nats-server wrapper that swallows the signals
    const shim = path.join(b.dir, 'no-reload.sh');
    fs.writeFileSync(shim, '#!/bin/sh\n[ "$1" = --signal ] && exit 0\nexec "$REAL" "$@"\n', {
      mode: 0o755,
    });
    b.admin(['init'], { env: { NATS_SERVER_BIN: shim, REAL: SERVER.serverBin } });
    assert.match(fs.readFileSync(path.join(b.confDir, 'users.conf'), 'utf8'), /"USER_dave"/);
    assert.equal(await reachesStreams(b, 'dave'), 'auth');

    b.reload();
    await until(
      'dave can log in after the first reload',
      async () => (await reachesStreams(b, 'dave')) !== 'auth',
    );
    for (let i = 0; i < 5; i++) {
      assert.equal(await reachesStreams(b, 'dave'), 'no answer', 'one reload was enough');
      await sleep(200);
    }
    assert.equal(await reachesStreams(b, 'alice'), 'ok'); // existing accounts are unaffected

    b.reload();
    await until(
      'dave reaches the streams after the second reload',
      async () => (await reachesStreams(b, 'dave')) === 'ok',
    );
  });
});

describe('upgrade from v0.5.7 to per-user accounts', { skip }, () => {
  const brokers: Broker[] = [];
  const watchers: Watcher[] = [];
  after(async () => {
    await Promise.all(watchers.map((w) => w.stop().catch(() => {})));
    for (const b of brokers) await b.stop();
  });
  const track = (w: Watcher): Watcher => (watchers.push(w), w);

  /** A server provisioned by v0.5.7's mbox-admin.sh, with alice and bob. */
  async function oldServer(): Promise<Broker> {
    const b = new Broker(SERVER, { adminScript: OLD_ADMIN.path });
    brokers.push(b);
    await b.init(['alice', 'bob']);
    return b;
  }
  /** `mbox` as one of the clients: the current bundle, or an earlier release's. */
  const run = (bundle: string, env: MachineEnv, session: string, args: string[], cwd?: string) =>
    mbox(args, { env: { ...env, AGENT_MAILBOX_SESSION: session }, cwd, bundle });
  const addrOf = (bundle: string, env: MachineEnv, session: string, cwd: string): string => {
    const r = run(bundle, env, session, ['whoami'], cwd);
    assert.equal(r.code, 0, r.stderr);
    return (r.stdout.split('\n')[0] ?? '').trim();
  };
  const usersConf = (b: Broker) => fs.readFileSync(path.join(b.confDir, 'users.conf'), 'utf8');

  it('init upgrades in place: queued mail, consumers and positions survive; the injection stops', async () => {
    const b = await oldServer();
    const [, old57] = OLD_CLIENTS[1];
    assert.equal(await injectAsAlice(b, 'before'), true, 'the old layout should be vulnerable');

    // bob's session reads one message with the old client, then goes away; two more queue up
    const aliceEnv = makeEnv(b, 'alice');
    const bobEnv = makeEnv(b, 'bob');
    const dir = projectDir('upgrade');
    const bobAddr = addrOf(old57.path, bobEnv, 'bob-up', dir);
    const w1 = track(new Watcher(bobEnv, { cwd: dir, session: 'bob-up', bundle: old57.path }));
    await w1.waitFor(/online as/);
    assert.equal(run(old57.path, aliceEnv, 'alice-up', ['send', bobAddr, 'pre-1'], dir).code, 0);
    await w1.waitFor(/pre-1/);
    await w1.stop();
    for (const t of ['pre-2', 'pre-3'])
      assert.equal(run(old57.path, aliceEnv, 'alice-up', ['send', bobAddr, t], dir).code, 0);
    const admin = await b.conn('admin');
    const jsm = await jetstreamManager(admin);
    const consumersBefore: string[] = [];
    for await (const c of jsm.consumers.list('MBX_BOB')) consumersBefore.push(c.name);
    assert.equal(consumersBefore.length, 1);
    const streamsBefore = (await jsm.streams.info('MBX_BOB')).state;
    const preUpgrade = await b.conn('alice');

    b.adminScript = ADMIN;
    const out = b.admin(['init']).out;
    assert.match(
      out,
      /upgrading to per-user accounts; saved the previous users\.conf and users\.d\//,
    );
    assert.match(out, /stream MBX_ALL now republishes broadcast headers/);
    assert.match(out, /kv bucket presence now refuses rollups/);
    assert.match(out, /reloaded nats-server/);

    // the old files are saved for a rollback; the new ones hold the same hashes, no permissions
    const backup = path.join(b.confDir, 'pre-accounts-backup');
    assert.match(
      fs.readFileSync(path.join(backup, 'users.d', 'alice.conf'), 'utf8'),
      /permissions:/,
    );
    const hash = (f: string) => /password: "([^"]+)"/.exec(fs.readFileSync(f, 'utf8'))?.[1];
    assert.equal(
      hash(path.join(b.confDir, 'users.d', 'alice.conf')),
      hash(path.join(backup, 'users.d', 'alice.conf')),
    );
    const aliceFile = fs.readFileSync(path.join(b.confDir, 'users.d', 'alice.conf'), 'utf8');
    assert.doesNotMatch(aliceFile, /allow:/);
    assert.match(
      aliceFile,
      /permissions: \{ publish: \{ deny: ">" \}, subscribe: \{ deny: ">" \} \}/,
    );
    assert.match(usersConf(b), /^# layout: per-user accounts/m);
    assert.ok(!fs.existsSync(path.join(b.confDir, 'users.conf.pending')));

    // connections from before the upgrade are closed; reconnecting lands in the user's account
    await until('the pre-upgrade connection to close', () => preUpgrade.isClosed());
    assert.equal(await reachesStreams(b, 'alice'), 'ok');
    assert.equal(
      await injectAsAlice(b, 'after'),
      false,
      'the injection still works after the upgrade',
    );

    // nothing moved: same stream state, same consumer, and the queued mail comes in order
    assert.equal((await jsm.streams.info('MBX_BOB')).state.last_seq, streamsBefore.last_seq);
    const consumersAfter: string[] = [];
    for await (const c of jsm.consumers.list('MBX_BOB')) consumersAfter.push(c.name);
    assert.deepEqual(consumersAfter, consumersBefore);
    const w2 = track(new Watcher(bobEnv, { cwd: dir, session: 'bob-up' }));
    await w2.waitFor(/pre-3/);
    assert.equal(run(old57.path, aliceEnv, 'alice-up', ['send', bobAddr, 'post-4'], dir).code, 0);
    await w2.waitFor(/post-4/);
    const got = w2.messages().map((m) => m.body);
    assert.deepEqual(got, ['pre-2', 'pre-3', 'post-4']);
    assert.ok(w2.messages().every((m) => m.verified === 'alice'));
    await w2.stop();

    // init again is a no-op
    const confBefore = usersConf(b);
    const again = b.admin(['init']).out;
    assert.match(again, /users\.conf unchanged: no server reload needed/);
    assert.doesNotMatch(again, /reloaded|upgrading|republishes|refuses/);
    assert.equal(usersConf(b), confBefore);
    await admin.close();
  });

  for (const [version, client] of OLD_CLIENTS)
    it(`client ${version}, unchanged, works against the upgraded server`, async () => {
      const b = await oldServer();
      b.adminScript = ADMIN;
      b.admin(['init']);
      const aliceEnv = makeEnv(b, 'alice');
      const bobEnv = makeEnv(b, 'bob');
      const dir = projectDir(`compat-${version}`);
      const s = `bob-${version.replace(/\./g, '')}`;
      const bobAddr = addrOf(client.path, bobEnv, s, dir);

      const doctor = run(client.path, bobEnv, s, ['doctor']);
      assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
      assert.match(doctor.stdout, /all checks passed/);

      const w = track(new Watcher(bobEnv, { cwd: dir, session: s, bundle: client.path }));
      await w.waitFor(/online as/);
      const peers = run(client.path, aliceEnv, 'alice-c', ['peers'], dir);
      assert.equal(peers.code, 0, peers.stderr);
      assert.ok(peers.stdout.includes(bobAddr), `presence: ${peers.stdout}`);

      assert.equal(
        run(client.path, aliceEnv, 'alice-c', ['send', bobAddr, `direct ${version}`], dir).code,
        0,
      );
      await w.waitFor(new RegExp(`direct ${version}`));
      assert.equal(
        run(client.path, aliceEnv, 'alice-c', ['send', 'all', `broadcast ${version}`], dir).code,
        0,
      );
      await w.waitFor(new RegExp(`broadcast ${version}`)); // live: the wake-up reaches the old client
      assert.ok(w.messages().every((m) => m.verified === 'alice'));
      await w.stop();

      // acknowledged: a new reader of the same session gets only what is new
      const w2 = track(new Watcher(bobEnv, { cwd: dir, session: s, bundle: client.path }));
      await w2.waitFor(/online as/);
      assert.equal(
        run(client.path, aliceEnv, 'alice-c', ['send', bobAddr, `again ${version}`], dir).code,
        0,
      );
      await w2.waitFor(new RegExp(`again ${version}`));
      assert.deepEqual(
        w2.messages().map((m) => m.body),
        [`again ${version}`],
      );
      await w2.stop();

      const inbox = run(client.path, bobEnv, s, ['inbox', '--since', '10m'], dir);
      assert.equal(inbox.code, 0, inbox.stderr);
      assert.match(inbox.stdout, new RegExp(`direct ${version}`));
    });

  it('an interrupted upgrade can be re-run', async () => {
    // The config check fails after users.d/ was migrated; the reload signal fails after users.conf
    // was written; then, with that change still unapplied, the config check fails again and the
    // pid file is missing (both must keep the pending marker); the second reload signal fails.
    const b = await oldServer();
    b.adminScript = ADMIN;
    const shim = path.join(b.dir, 'nats-server-shim.sh');
    fs.writeFileSync(
      shim,
      '#!/bin/sh\n' +
        'case "$1" in\n' +
        '  -t) [ "$FAIL" = check ] && exit 1 ;;\n' +
        '  --signal) n=$(cat "$COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$COUNT"\n' +
        '    { [ "$FAIL" = signal ] || { [ "$FAIL" = second ] && [ $n -ge 2 ]; }; } && exit 1 ;;\n' +
        'esac\n' +
        'exec "$REAL" "$@"\n',
      { mode: 0o755 },
    );
    const env = (fail: string) => ({
      NATS_SERVER_BIN: shim,
      REAL: SERVER.serverBin,
      FAIL: fail,
      COUNT: path.join(b.dir, `signals-${fail}`),
    });
    const pending = path.join(b.confDir, 'users.conf.pending');
    const backup = path.join(b.confDir, 'pre-accounts-backup', 'users.conf');

    const r1 = b.admin(['init'], { check: false, env: env('check') });
    assert.notEqual(r1.code, 0);
    assert.match(r1.out, /generated users\.conf is invalid, kept the previous one/);
    assert.doesNotMatch(usersConf(b), /^# layout: per-user accounts/m); // still the old one
    const original = fs.readFileSync(backup, 'utf8');

    const r2 = b.admin(['init'], { check: false, env: env('signal') });
    assert.notEqual(r2.code, 0);
    assert.match(usersConf(b), /^# layout: per-user accounts/m);
    assert.ok(fs.existsSync(pending), 'users.conf.pending marks the unapplied change');
    assert.equal(await injectAsAlice(b, 'interrupted-1'), true, 'not reloaded yet');

    writeUser(b, 'eve', 'eve-password-123456'); // users.conf changes again, and fails the check
    const r2b = b.admin(['init'], { check: false, env: env('check') });
    assert.notEqual(r2b.code, 0);
    assert.ok(fs.existsSync(pending), 'a failed check dropped the marker of an unapplied change');
    fs.rmSync(path.join(b.confDir, 'users.d', 'eve.conf'));
    const r2c = b.admin(['init'], {
      check: false,
      env: { MBOX_PID_FILE: path.join(b.dir, 'no.pid') },
    });
    assert.notEqual(r2c.code, 0);
    assert.match(r2c.out, /answers at .* but there is no live pid/);
    assert.ok(fs.existsSync(pending), 'a running server without a pid dropped the marker');

    const r3 = b.admin(['init'], { check: false, env: env('second') });
    assert.notEqual(r3.code, 0);
    assert.ok(fs.existsSync(pending));

    const r4 = b.admin(['init']);
    assert.match(r4.out, /reloaded nats-server/);
    assert.ok(!fs.existsSync(pending));
    assert.equal(
      fs.readFileSync(backup, 'utf8'),
      original,
      'a re-run must not overwrite the backup',
    );
    await until(
      'alice reaches the streams',
      async () => (await reachesStreams(b, 'alice')) === 'ok',
    );
    assert.equal(await reachesStreams(b, 'bob'), 'ok');
    assert.equal(await injectAsAlice(b, 'interrupted-2'), false);
  });

  it('an older mbox-admin.sh run after the upgrade locks users out, never opens the stream account', async () => {
    // 0.5.7's script copies users.d files verbatim into the stream account; the deny-all block
    // in them must then lock the users out instead of granting them the whole account.
    const b = await oldServer();
    b.adminScript = ADMIN;
    b.admin(['init']);
    b.adminScript = OLD_ADMIN.path;
    b.addUser('carol');
    assert.doesNotMatch(usersConf(b), /per-user accounts/);
    await until('alice is locked out of the stream account', async () => {
      const nc = await b.conn('alice').catch(() => null);
      if (!nc) return false;
      try {
        await nc.request('$JS.API.STREAM.NAMES', '', { timeout: 2000 });
        return false;
      } catch (e) {
        return /Permissions Violation/.test(String(e));
      } finally {
        await nc.close().catch(() => {});
      }
    });
    const nc = await b.conn('alice');
    const sub = nc.subscribe('mbx.bob.>');
    const res = await Promise.race([sub.closed, sleep(3000).then(() => 'still open')]);
    assert.ok(res instanceof Error && /Permissions Violation/.test(res.message), String(res));
    await nc.close().catch(() => {});
    // the current script's init upgrades again, the user the old one added included
    b.adminScript = ADMIN;
    assert.match(b.admin(['init']).out, /reloaded nats-server/);
    await until('alice is back', async () => (await reachesStreams(b, 'alice')) === 'ok');
    assert.equal(await reachesStreams(b, 'carol'), 'ok');
    assert.equal(await injectAsAlice(b, 'reupgraded'), false);
  });

  it('rolls back by restoring the saved files and reloading', async () => {
    const b = await oldServer();
    b.adminScript = ADMIN;
    b.admin(['init']);
    assert.equal(await reachesStreams(b, 'alice'), 'ok');
    const backup = path.join(b.confDir, 'pre-accounts-backup');
    fs.copyFileSync(path.join(backup, 'users.conf'), path.join(b.confDir, 'users.conf'));
    fs.rmSync(path.join(b.confDir, 'users.d'), { recursive: true });
    fs.cpSync(path.join(backup, 'users.d'), path.join(b.confDir, 'users.d'), { recursive: true });
    b.reload(); // twice, as the documented steps say (accounts change)
    await sleep(500);
    b.reload();
    b.adminScript = OLD_ADMIN.path;
    // the tell of the shared account: broadcasts reach other users in full, not as a wake-up
    await until('alice is back in the shared account', async () => {
      const alice = await b.conn('alice').catch(() => null);
      if (!alice) return false;
      const bob = await b.conn('bob');
      try {
        const sub = alice.subscribe('mbx.all.*', { max: 1, timeout: 3000 });
        await alice.flush();
        await jetstream(bob, { checkAPI: false }).publish('mbx.all.bob', 'rollback');
        for await (const m of sub) return m.string() === 'rollback';
        return false;
      } catch {
        return false;
      } finally {
        await alice.close();
        await bob.close();
      }
    });
    const [, old57] = OLD_CLIENTS[1];
    const bobEnv = makeEnv(b, 'bob');
    const doctor = run(old57.path, bobEnv, 'bob-rb', ['doctor']);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.deepEqual(b.admin(['list-users']).out.trim().split('\n'), ['alice', 'bob']);
  });
});
