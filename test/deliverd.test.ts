// `mbox deliverd` (push delivery into Claude Code's per-session inbox socket) against a real
// nats-server and a fake inbox socket (FakeInbox in helpers.ts mimics the discovered protocol).
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';
import { jetstream, jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import type { Env, Registration } from '../src/core/types.js';
import type { NatsConnection } from '@nats-io/transport-node';
import { consumerName } from '../src/core/transport/nats.js';
import {
  Broker,
  FakeInbox,
  MBOX,
  ROOT,
  Watcher,
  at,
  findServer,
  makeEnv,
  mbox,
  parseJson,
  projectDir,
  send,
  sleep,
  socketDir,
  type FakeInboxOptions,
  type HookOutput,
  type MachineEnv,
} from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();
const TOKEN = 'tok-5e1d9b0c7a3f4e2d8c6b';
/** The release the bundle was built as (scripts/build.mjs injects it from package.json). */
const VERSION = parseJson<{ version: string }>(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version;
// Daemon versions for the takeover tests (AGENT_MAILBOX_FAKE_VERSION, a test-only knob). 1.10.0 is
// newer than 1.9.2 only when compared as numbers, not as strings.
const OLD = '1.9.2';
const NEW = '1.10.0';
const as = <E extends Env>(env: E, version: string): E => ({
  ...env,
  AGENT_MAILBOX_FAKE_VERSION: version,
});
const re = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('mbox deliverd', { skip: SERVER.skip }, () => {
  let b: Broker;
  let aliceEnv: MachineEnv;
  let adminNc: NatsConnection;
  let jsm: JetStreamManager;
  const cleanup: Array<() => Promise<unknown>> = [];
  const hosts: ChildProcess[] = [];

  const ackPending = async (sid: string): Promise<number> => {
    try {
      const i = await jsm.consumers.info('MBX_BOB', consumerName(sid));
      return i.num_ack_pending + i.num_pending;
    } catch {
      return -1;
    }
  };
  const until = async (fn: () => unknown, what: string, timeoutMs = 15000): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await fn()) return;
      await sleep(50);
    }
    throw new Error(`timed out: ${what}${peersErr ? ` (${peersErr})` : ''}`);
  };
  const mail = (to: string, text: string): string => {
    const r = send(aliceEnv, 'alice-d', projectDir('alice-d'), to, text);
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };

  /** A "machine" for bob with its own state dir and fast timers. */
  const bobMachine = (extra: Env = {}): MachineEnv => {
    const env = makeEnv(b, 'bob', {
      AGENT_MAILBOX_PID_CHECK_MS: '300',
      AGENT_MAILBOX_DELIVERD_RESCAN_MS: '500',
      AGENT_MAILBOX_DELIVER_RETRY_MS: '200',
      AGENT_MAILBOX_DELIVER_MAX_RETRY_MS: '600',
      AGENT_MAILBOX_REDELIVER_MS: '2000',
      AGENT_MAILBOX_PAUSE_POLL_MS: '200',
      ...extra,
    });
    cleanup.push(() => stopDaemon(env));
    return env;
  };
  const statePath = (env: MachineEnv, ...p: string[]): string =>
    path.join(env.AGENT_MAILBOX_STATE_DIR, ...p);
  const daemonPid = (env: MachineEnv): number | null => {
    try {
      return parseJson<{ pid: number }>(fs.readFileSync(statePath(env, 'deliverd.lock'), 'utf8'))
        .pid;
    } catch {
      return null;
    }
  };
  const alive = (pid: number | null): boolean => {
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function stopDaemon(env: MachineEnv): Promise<void> {
    const pid = daemonPid(env);
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      await until(() => !alive(pid), 'daemon exit', 8000).catch(() => process.kill(pid, 'SIGKILL'));
    }
  }
  /** A stand-in for the Claude Code process (CLAUDE_PID). */
  const fakeHost = (): ChildProcess => {
    const p = spawn('sleep', ['600'], { stdio: 'ignore' });
    hosts.push(p);
    return p;
  };
  /** The SessionStart hook as Claude Code runs it, with the inbox socket in its environment. */
  interface HookOptions {
    socket?: string;
    token?: string;
    hostPid?: number;
    /** Run the hook from this copy of the bundle (another install path). */
    bundle?: string;
  }
  const hookEnv = (env: MachineEnv, { socket, token = TOKEN, hostPid }: HookOptions): Env => ({
    ...env,
    CLAUDECODE: '1',
    ...(socket ? { CLAUDE_CODE_MESSAGING_SOCKET: socket } : {}),
    ...(token ? { CLAUDE_CODE_MESSAGING_TOKEN: token } : {}),
    ...(hostPid ? { CLAUDE_PID: String(hostPid) } : {}),
  });
  const hookInput = (sid: string, dir: string): string =>
    JSON.stringify({
      session_id: sid,
      cwd: dir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
  const hookResult = (stdout: string): { ctx: string; address: string } => {
    const ctx = parseJson<HookOutput>(stdout).hookSpecificOutput.additionalContext;
    const address = /address is (\S+?)\. /.exec(ctx)?.[1];
    assert.ok(address, ctx);
    return { ctx, address };
  };
  const sessionStart = (
    env: MachineEnv,
    sid: string,
    dir: string,
    opts: HookOptions = {},
  ): { ctx: string; ms: number; address: string } => {
    const t0 = Date.now();
    const r = mbox(['hook', 'claude-code', 'session-start'], {
      env: hookEnv(env, opts),
      input: hookInput(sid, dir),
      ...(opts.bundle ? { bundle: opts.bundle } : {}),
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    return { ...hookResult(r.stdout), ms };
  };
  /** The SessionStart hook as a child process that is not waited for (sessions starting together). */
  const sessionStartAsync = (
    env: MachineEnv,
    sid: string,
    dir: string,
    opts: HookOptions = {},
  ): Promise<{ ctx: string; address: string }> =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [MBOX, 'hook', 'claude-code', 'session-start'], {
        env: hookEnv(env, opts),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      p.on('error', reject);
      p.on('exit', (code) => {
        if (code !== 0) reject(new Error(`hook exited ${code}: ${err}`));
        else resolve(hookResult(out));
      });
      p.stdin.end(hookInput(sid, dir));
    });
  const sessionEnd = (env: MachineEnv, sid: string): void => {
    const r = mbox(['hook', 'claude-code', 'session-end'], {
      env: { ...env, CLAUDECODE: '1' },
      input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', reason: 'other' }),
    });
    assert.equal(r.code, 0, r.stderr);
  };
  const inbox = async (sid: string, opts: FakeInboxOptions = {}): Promise<FakeInbox> => {
    const fake = new FakeInbox(path.join(socketDir(), 's.sock'), {
      sessionId: sid,
      token: TOKEN,
      ...opts,
    });
    await fake.start();
    cleanup.push(() => fake.stop());
    return fake;
  };
  const logOf = (env: MachineEnv): string => {
    try {
      return fs.readFileSync(statePath(env, 'deliverd.log'), 'utf8');
    } catch {
      return '';
    }
  };
  let peersErr = '';
  const peers = (): string => {
    const r = mbox(['peers'], { env: aliceEnv });
    peersErr = r.code === 0 ? '' : `mbox peers exited ${r.code}: ${r.stderr}`;
    return r.stdout;
  };
  /** Messages the daemon has received from the server and holds, unacknowledged. */
  const heldCount = async (sid: string): Promise<number> => {
    try {
      return (await jsm.consumers.info('MBX_BOB', consumerName(sid))).num_ack_pending;
    } catch {
      return -1;
    }
  };
  /**
   * `mbox pause <address>`, returning only once the daemon has acted on it. Mail sent after this is
   * held until resume however slowly it is sent, which makes "arrives together" independent of the
   * machine's speed (the 300 ms batching window cannot split it). The daemon's first look at the
   * pause file is silent, so if no log line shows up the pause is simply written again.
   */
  const pauseAndWait = async (env: MachineEnv, address: string): Promise<void> => {
    const seen = () => logOf(env).split(`delivery paused for ${address}`).length;
    const before = seen();
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = mbox(['pause', address], { env });
      assert.equal(p.code, 0, p.stderr);
      try {
        await until(() => seen() > before, 'daemon saw the pause', 1500);
        return;
      } catch {
        /* its first poll may have swallowed the change: write it again */
      }
    }
    throw new Error('the daemon never reported the pause');
  };

  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
    adminNc = await b.conn('admin');
    jsm = await jetstreamManager(adminNc);
  });
  after(async () => {
    for (const f of cleanup.reverse()) await f().catch(() => {});
    for (const h of hosts) h.kill('SIGKILL');
    await adminNc?.close();
    await b?.stop();
  });

  it('the hook registers the session (0600), starts the daemon without blocking, and mail arrives batched as separate blocks', async () => {
    const env = bobMachine();
    const sid = 'd-basic-1111';
    const fake = await inbox(sid);
    const host = fakeHost();
    assert.equal(daemonPid(env), null);
    const { ctx, ms, address } = sessionStart(env, sid, projectDir('basic'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    // The hook is meant to take well under a second (it does so on a normal machine) and Claude Code
    // gives it 10 s (hooks.json). The test only guards against it blocking on the daemon or the
    // network, so the limit has headroom for a loaded CI runner, where node's own start-up alone
    // can take a second.
    assert.ok(ms < 3000, `hook took ${ms} ms with the daemon down`);
    assert.match(
      ctx,
      /arrives on its own, between tool calls or as a new turn, as a cross-session message whose from-name is the sender's mailbox address/,
    );
    assert.match(ctx, /SendMessage cannot reach mailbox addresses/);
    assert.match(ctx, /mbox guide` for details/);

    const regFile = statePath(env, 'registrations', `${sid}.json`);
    assert.equal(fs.statSync(regFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(regFile)).mode & 0o777, 0o700);
    const reg = parseJson<Registration>(fs.readFileSync(regFile, 'utf8'));
    assert.deepEqual(
      { ...reg, registeredAt: 'x' },
      {
        sid,
        address,
        endpoint: { kind: 'claude-inbox-socket', path: fake.path, token: TOKEN },
        hostPid: host.pid,
        cwd: reg.cwd,
        agent: 'claude-code',
        registeredAt: 'x',
      },
    );

    await until(() => daemonPid(env) && alive(daemonPid(env)), 'daemon started');
    await until(() => peers().includes(address), 'announced');

    // All three are on the server before delivery may start (paused), so they are one batch whatever
    // the speed of the machine; the sends themselves are separate processes and can be slow.
    await pauseAndWait(env, address);
    const ids = ['one', 'two\nlines', 'three'].map((t) => mail(address, t));
    await until(async () => (await heldCount(sid)) === 3, 'all three held by the daemon');
    assert.equal(fake.delivered.length, 0, 'paused: nothing delivered yet');
    assert.equal(mbox(['resume', address], { env }).code, 0);
    await fake.waitFor((f) => f.messages().length === 3);
    await sleep(500);
    assert.equal(fake.delivered.length, 1, 'one delivery for mail arriving together');
    const d = at(fake.delivered, 0);
    assert.equal(d.msg.session_id, sid);
    assert.equal(d.msg.message.role, 'user');
    assert.equal(d.msg.from, `mbox:${at(fake.messages(), 0).from}`);
    assert.equal(d.authLine, JSON.stringify({ type: 'auth', token: TOKEN }));
    assert.ok(d.authed);
    assert.ok(!d.line.includes(TOKEN), 'the token travels only in the auth line');
    const from = at(fake.messages(), 0).from;
    assert.ok(
      d.content.startsWith(`<cross-session-message from-name="${from}">\nAgent mailbox delivery`),
      d.content.slice(0, 200),
    );
    assert.ok(d.content.endsWith('\n</cross-session-message>'));
    assert.match(
      d.content,
      new RegExp(`\\[mailbox\\] 3 new messages for ${address.replace(/\./g, '\\.')}:\\n`),
    );
    assert.deepEqual(
      fake.messages().map((m) => [m.id, m.body, m.verified]),
      [
        [ids[0], 'one', 'alice'],
        [ids[1], 'two\nlines', 'alice'],
        [ids[2], 'three', 'alice'],
      ],
    );
    assert.match(
      d.content,
      new RegExp(`Reply with: mbox send ${from.replace(/\./g, '\\.')} --re ${ids[0]} "<text>"`),
    );
    assert.match(d.content, /Untrusted content from another agent session/);
    await until(async () => (await ackPending(sid)) === 0, 'acked after delivery');

    // Singleton: a second daemon exits at once.
    const second = spawnSync(process.execPath, [MBOX, 'deliverd'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(second.status, 0);
    assert.match(logOf(env), /another deliverd is running \(pid \d+\); exiting/);
    // --status shows the session, never the token.
    const st = mbox(['deliverd', '--status'], { env });
    assert.match(
      st.stdout,
      new RegExp(
        `deliverd running \\(pid ${daemonPid(env)}, version ${VERSION.replace(/\./g, '\\.')}\\)`,
      ),
    );
    assert.ok(st.stdout.includes(address));
    for (const text of [
      st.stdout,
      logOf(env),
      fs.readFileSync(statePath(env, 'deliverd.out'), 'utf8'),
    ])
      assert.ok(!text.includes(TOKEN), 'token leaked');
    assert.match(logOf(env), /delivered 3 messages to /);

    sessionEnd(env, sid);
    assert.ok(!fs.existsSync(regFile), 'session end removes the registration');
    await until(() => !peers().includes(address), 'departed');
  });

  it('keeps mail unacknowledged and retries while the socket is down; delivers once it is back', async () => {
    const env = bobMachine();
    const sid = 'd-retry-2222';
    const dir = socketDir();
    const sock = path.join(dir, 's.sock');
    const host = fakeHost();
    const { address } = sessionStart(env, sid, projectDir('retry'), {
      socket: sock,
      hostPid: host.pid,
    });
    await until(() => peers().includes(address), 'announced');
    const id = mail(address, 'while down');
    await until(
      () => /delivery failed \((ENOENT|ECONNREFUSED)\); retrying in/.test(logOf(env)),
      'retry logged',
    );
    await sleep(800);
    assert.ok((await ackPending(sid)) > 0, 'not acknowledged while undelivered');
    const fake = new FakeInbox(sock, { sessionId: sid, token: TOKEN });
    await fake.start();
    cleanup.push(() => fake.stop());
    await fake.waitFor((f) => f.messages().length === 1);
    assert.equal(at(fake.messages(), 0).id, id);
    await until(async () => (await ackPending(sid)) === 0, 'acked after delivery');
    await sleep(2500); // past the redelivery interval: still exactly once
    assert.equal(fake.messages().length, 1);
    assert.match(logOf(env), /delivered 1 message to .* \(after \d+ failed attempts?\)/);
  });

  it('deregisters and departs when the session process dies; the mail stays on the server', async () => {
    const env = bobMachine();
    const sid = 'd-host-3333';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(env, sid, projectDir('host'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    await until(() => peers().includes(address), 'announced');
    host.kill('SIGKILL');
    await until(
      () => !fs.existsSync(statePath(env, 'registrations', `${sid}.json`)),
      'deregistered',
    );
    await until(() => !peers().includes(address), 'departed');
    assert.match(
      logOf(env),
      new RegExp(
        `${address.replace(/\./g, '\\.')}: session process ${host.pid} is gone; deregistered`,
      ),
    );
    const id = mail(address, 'after death');
    await sleep(1000);
    assert.equal(fake.delivered.length, 0);
    const later = mbox(['--session', sid, 'show', id], { env });
    assert.equal(later.code, 0, later.stderr);
    assert.match(later.stdout, /after death/);
  });

  it('no double delivery across a daemon restart (recorded, then killed before acknowledging)', async () => {
    const env = bobMachine();
    const sid = 'd-restart-4444';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(
      { ...env, AGENT_MAILBOX_FAULT: 'crash-after-commit' },
      sid,
      projectDir('restart'),
      { socket: fake.path, hostPid: host.pid },
    );
    await until(() => peers().includes(address), 'announced');
    const first = daemonPid(env);
    const id = mail(address, 'exactly once');
    await fake.waitFor((f) => f.messages().length === 1);
    await until(() => !alive(first), 'daemon crashed after recording');
    assert.ok((await ackPending(sid)) > 0, 'killed before the acknowledgement');
    // Any mbox command (or the next session start) brings the daemon back.
    assert.equal(mbox(['--session', sid, 'whoami'], { env }).code, 0);
    await until(
      () => daemonPid(env) && daemonPid(env) !== first && alive(daemonPid(env)),
      'daemon restarted',
    );
    await until(
      async () => (await ackPending(sid)) === 0,
      'redelivery recognised and acknowledged',
      20000,
    );
    const id2 = mail(address, 'next one');
    await fake.waitFor((f) => f.messages().length === 2);
    await sleep(500);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      [id, id2],
    );
  });

  it('runaway guard: at most AGENT_MAILBOX_MAX_PER_MIN per window, the rest held with one notice line', async () => {
    // Live arrival (nothing paused). The five messages are published over one connection, in a few
    // milliseconds, and the batching window is stretched to 1.5 s (a test knob), so they reach the
    // daemon together however slow the machine is; the assertions are on totals, order and the
    // notice count, never on which delivery a message happened to land in.
    const env = bobMachine({
      AGENT_MAILBOX_MAX_PER_MIN: '3',
      AGENT_MAILBOX_RATE_WINDOW_MS: '4000',
      AGENT_MAILBOX_DRAIN_MS: '1500',
    });
    const sid = 'd-rate-5555';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(env, sid, projectDir('rate'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    await until(() => peers().includes(address), 'announced');
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const nc = await b.conn('alice');
    const js = jetstream(nc, { checkAPI: false });
    for (const id of ids)
      await js.publish(
        `mbx.${address}.alice`,
        JSON.stringify({ v: 1, id, from: 'alice.laptop.x', to: address, body: id }),
        { msgID: id },
      );
    await nc.close();
    await fake.waitFor((f) => f.messages().length === 5, 20000);
    await sleep(500);
    const per = fake.delivered.map((d) => new Watcher.Parser(d.content).messages().length);
    assert.ok(
      per.every((n) => n <= 3),
      `no delivery above the limit: ${per.join(',')}`,
    );
    assert.equal(
      per.reduce((a, n) => a + n, 0),
      5,
    );
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ids,
      'every message once, in order, each a complete block',
    );
    const notices =
      fake
        .contents()
        .join('\n')
        .match(/^\[mailbox\] throttling: .*$/gm) || [];
    assert.equal(notices.length, 1, fake.contents().join('\n---\n'));
    assert.match(notices[0], /this session gets at most 3 messages per minute; /);
    assert.match(logOf(env), /: throttling, /);
  });

  it('runaway guard: mail already waiting beyond the limit is held with the notice in the same delivery', async () => {
    const env = bobMachine({
      AGENT_MAILBOX_MAX_PER_MIN: '3',
      AGENT_MAILBOX_RATE_WINDOW_MS: '6000',
    });
    const sid = 'd-rate-5556';
    const fake = await inbox(sid);
    const { address } = sessionStart(env, sid, projectDir('rate2'), {
      socket: fake.path,
      hostPid: fakeHost().pid,
    });
    await until(() => peers().includes(address), 'announced');
    await pauseAndWait(env, address);
    const ids = ['q1', 'q2', 'q3', 'q4', 'q5'].map((t) => mail(address, t));
    await until(async () => (await heldCount(sid)) === 5, 'all five held by the daemon');
    assert.equal(mbox(['resume', address], { env }).code, 0);
    await fake.waitFor((f) => f.delivered.length >= 1);
    await sleep(700); // far inside the 6 s window, so the held two cannot have been released by it
    assert.equal(fake.delivered.length, 1, 'the excess waits for the next window');
    const first = at(fake.delivered, 0).content;
    assert.equal(new Watcher.Parser(first).messages().length, 3);
    assert.match(
      first,
      /\n\[mailbox\] throttling: this session gets at most 3 messages per minute; 2 more messages are held and follow in the next window \(or read now: mbox inbox --since 10m\)\.\n<\/cross-session-message>$/,
    );
    await fake.waitFor((f) => f.messages().length === 5, 20000);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ids,
    );
    const last = fake.delivered.at(-1);
    assert.ok(last);
    assert.doesNotMatch(last.content, /throttling/);
    assert.match(logOf(env), /throttling, 2 held for the next window/);
  });

  it('a redelivery that arrives while its delivery is still in flight is not delivered twice', async () => {
    // The session's socket stays open for 4 s after reading (a busy session), longer than the 2 s
    // redelivery interval, so the server hands the daemon the same message again mid-delivery.
    const env = bobMachine();
    const sid = 'd-flight-5557';
    const fake = new FakeInbox(path.join(socketDir(), 's.sock'), {
      sessionId: sid,
      token: TOKEN,
      closeDelayMs: 4000,
    });
    await fake.start();
    cleanup.push(() => fake.stop());
    const { address } = sessionStart(env, sid, projectDir('flight'), {
      socket: fake.path,
      hostPid: fakeHost().pid,
    });
    await until(() => peers().includes(address), 'announced');
    const id = mail(address, 'only once');
    await fake.waitFor((f) => f.messages().length === 1);
    await until(async () => (await ackPending(sid)) === 0, 'acked after delivery', 20000);
    await sleep(3000); // past more redelivery intervals
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      [id],
      'delivered exactly once',
    );
  });

  it('mbox pause holds delivery (one session, or --all) until mbox resume', async () => {
    const env = bobMachine();
    const s1 = 'd-pause-6666';
    const s2 = 'd-pause-7777';
    const f1 = await inbox(s1);
    const f2 = await inbox(s2);
    const a1 = sessionStart(env, s1, projectDir('pause-a'), {
      socket: f1.path,
      hostPid: fakeHost().pid,
    }).address;
    const a2 = sessionStart(env, s2, projectDir('pause-b'), {
      socket: f2.path,
      hostPid: fakeHost().pid,
    }).address;
    await until(() => peers().includes(a1) && peers().includes(a2), 'announced');

    const p = mbox(['pause', a1], { env });
    assert.equal(p.code, 0, p.stderr);
    assert.match(p.stdout, new RegExp(`delivery paused for ${a1.replace(/\./g, '\\.')}`));
    await pauseAndWait(env, a1); // re-pausing is idempotent; returns once the daemon has acted on it
    mail(a1, 'held for a1');
    mail(a2, 'free for a2');
    await f2.waitFor((f) => f.messages().length === 1);
    await sleep(1000);
    assert.equal(f1.delivered.length, 0, 'paused session gets nothing');
    assert.ok((await ackPending(s1)) > 0, 'held mail stays unacknowledged');
    assert.match(
      mbox(['deliverd', '--status'], { env }).stdout,
      new RegExp(`paused: ${a1.replace(/\./g, '\\.')}`),
    );

    assert.equal(mbox(['pause', '--all'], { env }).code, 0);
    await until(() => logOf(env).includes('delivery paused for all sessions'), 'daemon saw --all');
    mail(a2, 'held for a2');
    await sleep(1200);
    assert.equal(f2.messages().length, 1, '--all holds every session');

    const r = mbox(['resume'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /delivery resumed for all sessions on this machine.*Still paused: nothing/,
    );
    await f1.waitFor((f) => f.messages().length === 1);
    await f2.waitFor((f) => f.messages().length === 2);
    assert.deepEqual(
      f1.messages().map((m) => m.body),
      ['held for a1'],
    );
    assert.match(logOf(env), /delivery paused for all sessions[\s\S]*delivery not paused/);
    assert.ok(!fs.existsSync(statePath(env, 'paused.json')));
  });

  it('exits on its own once no session is registered (idle timeout)', async () => {
    const env = bobMachine({ AGENT_MAILBOX_DELIVERD_IDLE_MS: '1500' });
    const sid = 'd-idle-8888';
    const fake = await inbox(sid);
    const { address } = sessionStart(env, sid, projectDir('idle'), {
      socket: fake.path,
      hostPid: fakeHost().pid,
    });
    await until(() => peers().includes(address), 'announced');
    const pid = daemonPid(env);
    await sleep(2500);
    assert.ok(alive(pid), 'stays while a session is registered');
    sessionEnd(env, sid);
    await until(() => !alive(pid), 'idle exit', 10000);
    assert.match(logOf(env), /stopping \(idle\)/);
    assert.equal(
      mbox(['deliverd', '--status'], { env }).stdout.split('\n')[0],
      'deliverd not running',
    );
  });

  // ---------------------------------------------------------------- version takeover
  /** The daemon's lock file: {pid, startedAt, version, exe}. */
  const lockOf = (env: MachineEnv): { pid: number; version?: string; exe?: string } =>
    parseJson(fs.readFileSync(statePath(env, 'deliverd.lock'), 'utf8'));
  /** Publish straight to the stream, one connection, in order (fast, whatever the machine). */
  const publish = async (address: string, ids: string[]): Promise<void> => {
    const nc = await b.conn('alice');
    const js = jetstream(nc, { checkAPI: false });
    for (const id of ids)
      await js.publish(
        `mbx.${address}.alice`,
        JSON.stringify({ v: 1, id, from: 'alice.laptop.x', to: address, body: id }),
        { msgID: id },
      );
    await nc.close();
  };
  /** The log lines matching `pattern`. */
  const logLines = (env: MachineEnv, pattern: RegExp): string[] =>
    logOf(env)
      .split('\n')
      .filter((l) => pattern.test(l));
  /**
   * Asserts that the log holds lines matching each pattern, in this order. Only for lines one
   * process writes: the old daemon, the new one and the hook append to the same file, and nothing
   * orders two processes' lines (the old daemon releases its lock before it logs "stopped", so the
   * new one's "taking over" can come first).
   */
  const assertLogOrder = (env: MachineEnv, patterns: RegExp[]): void => {
    const lines = logOf(env).split('\n');
    let from = 0;
    for (const p of patterns) {
      const i = lines.findIndex((l, n) => n >= from && p.test(l));
      assert.ok(i >= 0, `log: no ${p} after line ${from}:\n${lines.join('\n')}`);
      from = i + 1;
    }
  };
  /** A copy of the bundle in its own directory (another install path, e.g. an older plugin cache). */
  const bundleCopy = (): string => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'amb-bundle-'));
    const file = path.join(dir, 'mbox.mjs');
    fs.copyFileSync(MBOX, file);
    return file;
  };

  it('--status and --version show the version the bundle was built as', async () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(mbox(['--version']).stdout.trim(), VERSION);
    const env = bobMachine();
    const sid = 'd-ver-0001';
    const fake = await inbox(sid);
    sessionStart(env, sid, projectDir('ver'), { socket: fake.path, hostPid: fakeHost().pid });
    await until(() => alive(daemonPid(env)), 'daemon started');
    const lock = lockOf(env);
    assert.equal(lock.version, VERSION);
    assert.equal(lock.exe, MBOX);
    const st = mbox(['deliverd', '--status'], { env }).stdout;
    assert.match(
      st,
      new RegExp(`^deliverd running \\(pid ${lock.pid}, version ${re(VERSION)}\\)$`, 'm'),
    );
    assert.match(st, new RegExp(`^executable: ${re(MBOX)}$`, 'm'));
    assert.doesNotMatch(st, /this mbox is/);
  });

  it('a newer session-start hook takes delivery over: the old daemon hands over and exits, the new one serves; mail before, during and after arrives exactly once and in order', async () => {
    const env = bobMachine();
    const sid = 'd-take-1001';
    // A busy session: the first delivery stays in flight until the old daemon has begun to hand
    // over (the inbox post itself gives up after 10 s).
    const fake = await inbox(sid);
    let release!: () => void;
    fake.hold = new Promise<void>((r) => (release = r));
    const host = fakeHost();
    const { address } = sessionStart(as(env, OLD), sid, projectDir('take'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    await until(() => alive(daemonPid(env)), 'old daemon started');
    const oldPid = lockOf(env).pid;
    assert.equal(lockOf(env).version, OLD);
    await until(() => peers().includes(address), 'announced');

    await publish(address, ['b1', 'b2']);
    await fake.waitFor((f) => f.delivered.length === 1); // in flight now
    await publish(address, ['b3', 'b4']); // wait in the old daemon behind the delivery in flight
    await until(async () => (await heldCount(sid)) === 4, 'all four held by the old daemon');

    const { ms } = sessionStart(as(env, NEW), sid, projectDir('take'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    assert.ok(ms < 3000, `the hook took ${ms} ms: it must not wait for the handover`);
    await until(() => /stopping \(SIGTERM/.test(logOf(env)), 'the old daemon is handing over');
    await publish(address, ['d1', 'd2']); // during the handover, while the old daemon still delivers
    fake.hold = null; // later deliveries are quick
    release();
    await until(() => !alive(oldPid), 'old daemon exited', 30000);
    await until(
      () => logLines(env, new RegExp(`started \\(pid \\d+, version ${re(NEW)}\\)`)).length === 1,
      'new daemon started',
      20000,
    );
    await until(
      () => logLines(env, new RegExp(`^\\S+ serving ${re(address)}$`)).length === 2,
      'new daemon serving',
      20000,
    );
    await publish(address, ['a1', 'a2']); // after
    await fake.waitFor((f) => f.messages().length === 8, 30000);
    await until(async () => (await ackPending(sid)) === 0, 'all acknowledged', 20000);
    await sleep(2500); // past the redelivery interval: still exactly once
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ['b1', 'b2', 'b3', 'b4', 'd1', 'd2', 'a1', 'a2'],
      'every message once, in order',
    );
    const lock = lockOf(env);
    assert.notEqual(lock.pid, oldPid);
    assert.equal(lock.version, NEW);
    assert.ok(alive(lock.pid));
    // Each step is in the log. The hook's request, the old daemon's steps (the delivery in flight
    // finished after the handover began) and the new daemon's steps each in their own order.
    assert.equal(
      logLines(
        env,
        new RegExp(`handover requested: deliverd ${re(OLD)} \\(pid ${oldPid}\\) -> ${re(NEW)}$`),
      ).length,
      1,
    );
    assertLogOrder(env, [
      new RegExp(`stopping \\(SIGTERM; handing over to ${re(NEW)}\\)$`),
      /delivered \d+ messages? to /,
      new RegExp(`stopped \\(pid ${oldPid}, version ${re(OLD)}\\)$`),
    ]);
    assertLogOrder(env, [
      new RegExp(`deliverd ${re(OLD)} \\(pid ${oldPid}\\) exited; taking over$`),
      new RegExp(`started \\(pid ${lock.pid}, version ${re(NEW)}\\)$`),
      new RegExp(`serving ${re(address)}$`),
    ]);
    assert.equal(logLines(env, /another deliverd is running/).length, 0);
  });

  it('same version: no takeover, also when the hook runs from a bundle at another path', async () => {
    const env = bobMachine();
    const s1 = 'd-same-1002';
    const s2 = 'd-same-1003';
    const f1 = await inbox(s1);
    const f2 = await inbox(s2);
    sessionStart(env, s1, projectDir('same-a'), { socket: f1.path, hostPid: fakeHost().pid });
    await until(() => alive(daemonPid(env)), 'daemon started');
    const pid = daemonPid(env);
    const copy = bundleCopy();
    const { address } = sessionStart(env, s2, projectDir('same-b'), {
      socket: f2.path,
      hostPid: fakeHost().pid,
      bundle: copy,
    });
    await until(() => peers().includes(address), 'second session served');
    await publish(address, ['s1']);
    await f2.waitFor((f) => f.messages().length === 1);
    assert.equal(daemonPid(env), pid, 'the same daemon serves both');
    assert.equal(lockOf(env).exe, MBOX);
    assert.equal(logLines(env, /handover requested|waiting for deliverd|started \(/).length, 1);
    const st = mbox(['deliverd', '--status'], { env, bundle: copy }).stdout;
    assert.match(st, new RegExp(`deliverd running \\(pid ${pid}, version ${re(VERSION)}\\)`));
    assert.doesNotMatch(st, /this mbox is/);
  });

  it('an older session-start hook never downgrades the daemon', async () => {
    const env = bobMachine();
    const s1 = 'd-down-1004';
    const s2 = 'd-down-1005';
    const f1 = await inbox(s1);
    const f2 = await inbox(s2);
    sessionStart(as(env, NEW), s1, projectDir('down-a'), {
      socket: f1.path,
      hostPid: fakeHost().pid,
    });
    await until(() => alive(daemonPid(env)), 'daemon started');
    const pid = daemonPid(env);
    const { address } = sessionStart(as(env, OLD), s2, projectDir('down-b'), {
      socket: f2.path,
      hostPid: fakeHost().pid,
    });
    await until(() => peers().includes(address), 'served by the newer daemon');
    await publish(address, ['n1']);
    await f2.waitFor((f) => f.messages().length === 1);
    assert.equal(daemonPid(env), pid);
    assert.equal(lockOf(env).version, NEW);
    assert.equal(logLines(env, /handover requested|waiting for deliverd/).length, 0);
    // A daemon started by hand from the older version leaves too.
    const r = spawnSync(process.execPath, [MBOX, 'deliverd'], {
      env: as(env, OLD),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(daemonPid(env), pid);
    assert.match(logOf(env), /another deliverd is running \(pid \d+\); exiting/);
    assert.match(
      mbox(['deliverd', '--status'], { env: as(env, OLD) }).stdout,
      new RegExp(`this mbox is ${re(OLD)} \\(older\\): it leaves the daemon alone`),
    );
  });

  it('a daemon that will not hand over is terminated after the timeout, and no mail is lost', async () => {
    const env = bobMachine({ AGENT_MAILBOX_HANDOVER_MS: '3000' });
    const sid = 'd-stuck-1006';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(
      { ...as(env, OLD), AGENT_MAILBOX_FAULT: 'ignore-sigterm' },
      sid,
      projectDir('stuck'),
      { socket: fake.path, hostPid: host.pid },
    );
    await until(() => alive(daemonPid(env)), 'old daemon started');
    const oldPid = lockOf(env).pid;
    await until(() => peers().includes(address), 'announced');
    await publish(address, ['k1']);
    await fake.waitFor((f) => f.messages().length === 1);
    // Two more, held unacknowledged by the old daemon when it is killed.
    await pauseAndWait(env, address);
    await publish(address, ['k2', 'k3']);
    await until(async () => (await heldCount(sid)) === 2, 'both held by the old daemon');

    sessionStart(as(env, NEW), sid, projectDir('stuck'), { socket: fake.path, hostPid: host.pid });
    await until(() => !alive(oldPid), 'old daemon killed', 30000);
    await until(() => alive(daemonPid(env)) && lockOf(env).version === NEW, 'new daemon', 20000);
    assert.equal(mbox(['resume'], { env }).code, 0);
    await fake.waitFor((f) => f.messages().length === 3, 30000);
    await publish(address, ['k4']);
    await fake.waitFor((f) => f.messages().length === 4, 20000);
    await until(async () => (await ackPending(sid)) === 0, 'all acknowledged', 20000);
    await sleep(2500);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ['k1', 'k2', 'k3', 'k4'],
    );
    assert.equal(logLines(env, /handover requested: /).length, 1);
    assert.ok(logLines(env, /ignoring SIGTERM \(test fault\)/).length >= 1);
    assertLogOrder(env, [
      new RegExp(
        `deliverd ${re(OLD)} \\(pid ${oldPid}\\) did not exit within 3 s; terminating it \\(SIGKILL\\)$`,
      ),
      new RegExp(`deliverd ${re(OLD)} \\(pid ${oldPid}\\) was terminated; taking over$`),
      new RegExp(`started \\(pid \\d+, version ${re(NEW)}\\)$`),
    ]);
  });

  it('mail sent while a killed daemon still owes earlier messages waits for them: all in order', async () => {
    // A long redelivery interval: the next daemon starts while the killed one's two messages are
    // still out (unacknowledged and not yet due again), so the server offers the one sent after
    // them first. The daemon holds it until the two are back.
    const env = bobMachine({ AGENT_MAILBOX_REDELIVER_MS: '8000' });
    const sid = 'd-owed-1013';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(env, sid, projectDir('owed'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    await until(() => peers().includes(address), 'announced');
    const first = daemonPid(env);
    await pauseAndWait(env, address);
    await publish(address, ['o1', 'o2']);
    await until(async () => (await heldCount(sid)) === 2, 'both held by the daemon');
    if (first) process.kill(first, 'SIGKILL');
    await until(() => !alive(first), 'daemon killed');
    assert.equal(mbox(['resume'], { env }).code, 0);
    await publish(address, ['o3']);
    sessionStart(env, sid, projectDir('owed'), { socket: fake.path, hostPid: host.pid });
    await until(() => alive(daemonPid(env)) && daemonPid(env) !== first, 'daemon restarted');
    await fake.waitFor((f) => f.messages().length === 3, 30000);
    await until(async () => (await ackPending(sid)) === 0, 'all acknowledged', 20000);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ['o1', 'o2', 'o3'],
      'every message once, in send order',
    );
  });

  it('a handover that loses the newest handed-back message (the stop gap): newer mail waits for it, all in order', async () => {
    // The old daemon hands h1 and h2 back but loses h3 (a test knob), as if the server had sent h3
    // in the instant the old daemon stopped listening: h3 comes back only after the redelivery
    // interval. The new daemon starts slowly (another knob), and h4 is sent meanwhile, so the
    // server offers it before h3.
    const env = bobMachine({ AGENT_MAILBOX_REDELIVER_MS: '4000' });
    const sid = 'd-gap-1014';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(
      { ...as(env, OLD), AGENT_MAILBOX_TEST_LOSE_HANDBACK: '1' },
      sid,
      projectDir('gap'),
      { socket: fake.path, hostPid: host.pid },
    );
    await until(() => alive(daemonPid(env)), 'old daemon started');
    const oldPid = lockOf(env).pid;
    await until(() => peers().includes(address), 'announced');
    await pauseAndWait(env, address);
    await publish(address, ['h1', 'h2', 'h3']);
    await until(async () => (await heldCount(sid)) === 3, 'all three held by the old daemon');

    sessionStart(
      { ...as(env, NEW), AGENT_MAILBOX_TEST_START_DELAY_MS: '3000' },
      sid,
      projectDir('gap'),
      {
        socket: fake.path,
        hostPid: host.pid,
      },
    );
    await until(() => !alive(oldPid), 'old daemon exited', 30000);
    assert.equal(mbox(['resume'], { env }).code, 0);
    await until(
      () => logLines(env, new RegExp(`^\\S+ serving ${re(address)}$`)).length === 2,
      'new daemon serving',
      20000,
    );
    await publish(address, ['h4']); // while the new daemon is still starting
    await fake.waitFor((f) => f.messages().length === 4, 30000);
    await until(async () => (await ackPending(sid)) === 0, 'all acknowledged', 20000);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ['h1', 'h2', 'h3', 'h4'],
      'every message once, in send order',
    );
  });

  it('a hand-back that comes after the redelivery interval keeps the order', async () => {
    // The old daemon hands back 3 s late (a test knob), after the 2 s redelivery interval: the
    // server has already queued l1 and l2 again, and l3 is sent in between.
    const env = bobMachine();
    const sid = 'd-late-1015';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(
      { ...as(env, OLD), AGENT_MAILBOX_TEST_HANDBACK_DELAY_MS: '3000' },
      sid,
      projectDir('late'),
      { socket: fake.path, hostPid: host.pid },
    );
    await until(() => alive(daemonPid(env)), 'old daemon started');
    const oldPid = lockOf(env).pid;
    await until(() => peers().includes(address), 'announced');
    await pauseAndWait(env, address);
    await publish(address, ['l1', 'l2']);
    await until(async () => (await heldCount(sid)) === 2, 'both held by the old daemon');

    sessionStart(as(env, NEW), sid, projectDir('late'), { socket: fake.path, hostPid: host.pid });
    await until(() => /stopping \(SIGTERM/.test(logOf(env)), 'the old daemon is handing over');
    await publish(address, ['l3']); // while the hand-back is delayed
    await until(() => !alive(oldPid), 'old daemon exited', 30000);
    assert.equal(mbox(['resume'], { env }).code, 0);
    await fake.waitFor((f) => f.messages().length === 3, 30000);
    await publish(address, ['l4']);
    await fake.waitFor((f) => f.messages().length === 4, 20000);
    await until(async () => (await ackPending(sid)) === 0, 'all acknowledged', 20000);
    assert.deepEqual(
      fake.messages().map((m) => m.id),
      ['l1', 'l2', 'l3', 'l4'],
      'every message once, in send order',
    );
  });

  it('two sessions starting together with a newer version start one new daemon', async () => {
    const env = bobMachine();
    const ids = ['d-pair-1007', 'd-pair-1008', 'd-pair-1009'];
    const fakes = await Promise.all(ids.map((sid) => inbox(sid)));
    const [s0, s1, s2] = ids as [string, string, string];
    const [f0, f1, f2] = fakes as [FakeInbox, FakeInbox, FakeInbox];
    sessionStart(as(env, OLD), s0, projectDir('pair-0'), {
      socket: f0.path,
      hostPid: fakeHost().pid,
    });
    await until(() => alive(daemonPid(env)), 'old daemon started');
    const oldPid = lockOf(env).pid;
    const [r1, r2] = await Promise.all([
      sessionStartAsync(as(env, NEW), s1, projectDir('pair-1'), {
        socket: f1.path,
        hostPid: fakeHost().pid,
      }),
      sessionStartAsync(as(env, NEW), s2, projectDir('pair-2'), {
        socket: f2.path,
        hostPid: fakeHost().pid,
      }),
    ]);
    await until(() => !alive(oldPid), 'old daemon exited', 30000);
    await until(() => alive(daemonPid(env)) && lockOf(env).version === NEW, 'new daemon', 20000);
    await until(
      () => peers().includes(r1.address) && peers().includes(r2.address),
      'both served',
      20000,
    );
    for (const [sid, f] of [
      [s0, f0],
      [s1, f1],
      [s2, f2],
    ] as const) {
      const address = parseJson<{ address: string }>(
        fs.readFileSync(statePath(env, 'registrations', `${sid}.json`), 'utf8'),
      ).address;
      await publish(address, [`p-${sid}`]);
      await f.waitFor((x) => x.messages().length === 1, 20000);
    }
    await sleep(1000);
    assert.deepEqual(
      fakes.map((f) => f.messages().map((m) => m.id)),
      ids.map((sid) => [`p-${sid}`]),
    );
    assert.equal(logLines(env, /handover requested/).length, 1, logOf(env));
    assert.equal(
      logLines(env, new RegExp(`started \\(pid \\d+, version ${re(NEW)}\\)`)).length,
      1,
      logOf(env),
    );
    assert.equal(
      logLines(env, /another deliverd is running|waiting for the lock/).length,
      0,
      logOf(env),
    );
  });

  it('a stale lock (a crashed daemon) is replaced, and a daemon from before 0.5.3 (no version) is taken over', async () => {
    const env = bobMachine();
    // Crashed: a dead pid in a freshly touched lock.
    const dead = spawnSync('true').pid;
    fs.mkdirSync(env.AGENT_MAILBOX_STATE_DIR, { recursive: true });
    fs.writeFileSync(
      statePath(env, 'deliverd.lock'),
      JSON.stringify({ pid: dead, startedAt: Date.now(), version: NEW }) + '\n',
    );
    const s1 = 'd-stale-1010';
    const f1 = await inbox(s1);
    const a1 = sessionStart(env, s1, projectDir('stale'), {
      socket: f1.path,
      hostPid: fakeHost().pid,
    }).address;
    await until(() => alive(daemonPid(env)) && lockOf(env).pid !== dead, 'daemon started');
    await until(() => peers().includes(a1), 'served');
    await publish(a1, ['x1']);
    await f1.waitFor((f) => f.messages().length === 1);
    assert.equal(logLines(env, /handover requested/).length, 0, 'a dead daemon is not asked');
    await stopDaemon(env);

    // Before 0.5.3: a live holder whose lock records no version (a stand-in process).
    const old = spawn('sleep', ['600'], { stdio: 'ignore' });
    hosts.push(old);
    const oldPid = old.pid ?? 0;
    fs.writeFileSync(
      statePath(env, 'deliverd.lock'),
      JSON.stringify({ pid: oldPid, startedAt: Date.now() }) + '\n',
    );
    assert.match(
      mbox(['deliverd', '--status'], { env }).stdout,
      new RegExp(`deliverd running \\(pid ${oldPid}, version \\(before 0\\.5\\.3\\)\\)`),
    );
    const s2 = 'd-stale-1011';
    const f2 = await inbox(s2);
    const a2 = sessionStart(env, s2, projectDir('stale2'), {
      socket: f2.path,
      hostPid: fakeHost().pid,
    }).address;
    await until(() => !alive(oldPid), 'asked to stop (SIGTERM)');
    await until(() => alive(daemonPid(env)) && lockOf(env).version === VERSION, 'new daemon');
    await until(() => peers().includes(a2), 'served');
    await publish(a2, ['x2']);
    await f2.waitFor((f) => f.messages().length === 1);
    assert.match(
      logOf(env),
      new RegExp(
        `handover requested: deliverd \\(before 0\\.5\\.3\\) \\(pid ${oldPid}\\) -> ${re(VERSION)}`,
      ),
    );
  });

  it('a daemon whose bundle has been deleted (an old plugin cache) is still taken over', async () => {
    const env = bobMachine();
    const sid = 'd-gone-1012';
    const fake = await inbox(sid);
    const host = fakeHost();
    const copy = bundleCopy();
    const first = sessionStart(as(env, OLD), sid, projectDir('gone'), {
      socket: fake.path,
      hostPid: host.pid,
      bundle: copy,
    });
    await until(() => alive(daemonPid(env)), 'old daemon started');
    await until(() => peers().includes(first.address), 'served by the old daemon');
    const oldPid = lockOf(env).pid;
    assert.equal(lockOf(env).exe, copy);
    fs.rmSync(path.dirname(copy), { recursive: true, force: true });
    const st = mbox(['deliverd', '--status'], { env: as(env, NEW) }).stdout;
    assert.match(
      st,
      new RegExp(`executable: ${re(copy)} \\(no longer exists; it runs from memory\\)`),
    );
    assert.match(
      st,
      new RegExp(`this mbox is ${re(NEW)}: the next session start hands delivery over to it`),
    );
    const { address } = sessionStart(as(env, NEW), sid, projectDir('gone'), {
      socket: fake.path,
      hostPid: host.pid,
    });
    await until(() => !alive(oldPid), 'old daemon exited', 30000);
    await until(() => alive(daemonPid(env)) && lockOf(env).version === NEW, 'new daemon', 20000);
    await until(
      () => logLines(env, new RegExp(`serving ${re(address)}$`)).length === 2,
      'new daemon serving',
      20000,
    );
    await publish(address, ['g1']);
    await fake.waitFor((f) => f.messages().length === 1);
    assert.equal(lockOf(env).exe, MBOX);
  });
});
