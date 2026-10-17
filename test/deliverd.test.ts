// `mbox deliverd` (push delivery into Claude Code's per-session inbox socket) against a real
// nats-server and a fake inbox socket (FakeInbox in helpers.ts mimics the discovered protocol).
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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
  const sessionStart = (
    env: MachineEnv,
    sid: string,
    dir: string,
    { socket, token = TOKEN, hostPid }: { socket?: string; token?: string; hostPid?: number } = {},
  ): { ctx: string; ms: number; address: string } => {
    const e = {
      ...env,
      CLAUDECODE: '1',
      ...(socket ? { CLAUDE_CODE_MESSAGING_SOCKET: socket } : {}),
      ...(token ? { CLAUDE_CODE_MESSAGING_TOKEN: token } : {}),
      ...(hostPid ? { CLAUDE_PID: String(hostPid) } : {}),
    };
    const t0 = Date.now();
    const r = mbox(['hook', 'claude-code', 'session-start'], {
      env: e,
      input: JSON.stringify({
        session_id: sid,
        cwd: dir,
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    const ctx = parseJson<HookOutput>(r.stdout).hookSpecificOutput.additionalContext;
    const address = /address is (\S+?)\. /.exec(ctx)?.[1];
    assert.ok(address, ctx);
    return { ctx, ms, address };
  };
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
    assert.match(st.stdout, new RegExp(`deliverd running \\(pid ${daemonPid(env)}\\)`));
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
});
