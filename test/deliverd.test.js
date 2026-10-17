// `mbox deliverd` (push delivery into Claude Code's per-session inbox socket) against a real
// nats-server and a fake inbox socket (FakeInbox in helpers.js mimics the discovered protocol).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { jetstreamManager } from '@nats-io/jetstream';
import { consumerName } from '../src/core/transport/nats.js';
import { Broker, FakeInbox, MBOX, Watcher, findServer, makeEnv, mbox, projectDir, send, sleep, socketDir } from './helpers.js';

const SERVER = findServer();
const TOKEN = 'tok-5e1d9b0c7a3f4e2d8c6b';

describe('mbox deliverd', { skip: SERVER.skip }, () => {
  let b;
  let aliceEnv;
  let adminNc;
  let jsm;
  const cleanup = [];
  const hosts = [];

  const ackPending = async (sid) => {
    try {
      const i = await jsm.consumers.info('MBX_BOB', consumerName(sid));
      return i.num_ack_pending + i.num_pending;
    } catch {
      return -1;
    }
  };
  const until = async (fn, what, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await fn()) return;
      await sleep(50);
    }
    throw new Error(`timed out: ${what}`);
  };
  const mail = (to, text) => {
    const r = send(aliceEnv, 'alice-d', projectDir('alice-d'), to, text);
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };

  /** A "machine" for bob with its own state dir and fast timers. */
  const bobMachine = (extra = {}) => {
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
  const statePath = (env, ...p) => path.join(env.AGENT_MAILBOX_STATE_DIR, ...p);
  const daemonPid = (env) => {
    try {
      return JSON.parse(fs.readFileSync(statePath(env, 'deliverd.lock'), 'utf8')).pid;
    } catch {
      return null;
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function stopDaemon(env) {
    const pid = daemonPid(env);
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      await until(() => !alive(pid), 'daemon exit', 8000).catch(() => process.kill(pid, 'SIGKILL'));
    }
  }
  /** A stand-in for the Claude Code process (CLAUDE_PID). */
  const fakeHost = () => {
    const p = spawn('sleep', ['600'], { stdio: 'ignore' });
    hosts.push(p);
    return p;
  };
  /** The SessionStart hook as Claude Code runs it, with the inbox socket in its environment. */
  const sessionStart = (env, sid, dir, { socket, token = TOKEN, hostPid } = {}) => {
    const e = { ...env, CLAUDECODE: '1', ...(socket ? { CLAUDE_CODE_MESSAGING_SOCKET: socket } : {}), ...(token ? { CLAUDE_CODE_MESSAGING_TOKEN: token } : {}), ...(hostPid ? { CLAUDE_PID: String(hostPid) } : {}) };
    const t0 = Date.now();
    const r = mbox(['hook', 'claude-code', 'session-start'], { env: e, input: JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }) });
    const ms = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    return { ctx, ms, address: ctx.match(/address is (\S+?)\. /)[1] };
  };
  const sessionEnd = (env, sid) => {
    const r = mbox(['hook', 'claude-code', 'session-end'], { env: { ...env, CLAUDECODE: '1' }, input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', reason: 'other' }) });
    assert.equal(r.code, 0, r.stderr);
  };
  const inbox = async (sid, opts = {}) => {
    const fake = new FakeInbox(path.join(socketDir(), 's.sock'), { sessionId: sid, token: TOKEN, ...opts });
    await fake.start();
    cleanup.push(() => fake.stop());
    return fake;
  };
  const logOf = (env) => {
    try {
      return fs.readFileSync(statePath(env, 'deliverd.log'), 'utf8');
    } catch {
      return '';
    }
  };
  const peers = () => mbox(['peers'], { env: aliceEnv }).stdout;

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

  it('the hook registers the session (0600), starts the daemon in under a second, and mail arrives batched as separate blocks', async () => {
    const env = bobMachine();
    const sid = 'd-basic-1111';
    const fake = await inbox(sid);
    const host = fakeHost();
    assert.equal(daemonPid(env), null);
    const { ctx, ms, address } = sessionStart(env, sid, projectDir('basic'), { socket: fake.path, hostPid: host.pid });
    assert.ok(ms < 1000, `hook took ${ms} ms with the daemon down`);
    assert.match(ctx, /arrives on its own, between tool calls or as a new turn, as a cross-session message whose from-name is the sender's mailbox address/);
    assert.match(ctx, /SendMessage cannot reach mailbox addresses/);
    assert.match(ctx, /mbox guide` for details/);

    const regFile = statePath(env, 'registrations', `${sid}.json`);
    assert.equal(fs.statSync(regFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(regFile)).mode & 0o777, 0o700);
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    assert.deepEqual({ ...reg, registeredAt: 'x' }, { sid, address, endpoint: { kind: 'claude-inbox-socket', path: fake.path, token: TOKEN }, hostPid: host.pid, cwd: reg.cwd, agent: 'claude-code', registeredAt: 'x' });

    await until(() => daemonPid(env) && alive(daemonPid(env)), 'daemon started');
    await until(() => peers().includes(address), 'announced');

    const ids = ['one', 'two\nlines', 'three'].map((t) => mail(address, t));
    await fake.waitFor((f) => f.messages().length === 3);
    await sleep(500);
    assert.equal(fake.delivered.length, 1, 'one delivery for mail arriving together');
    const d = fake.delivered[0];
    assert.equal(d.msg.session_id, sid);
    assert.equal(d.msg.message.role, 'user');
    assert.equal(d.msg.from, `mbox:${fake.messages()[0].from}`);
    assert.equal(d.authLine, JSON.stringify({ type: 'auth', token: TOKEN }));
    assert.ok(d.authed);
    assert.ok(!d.line.includes(TOKEN), 'the token travels only in the auth line');
    const from = fake.messages()[0].from;
    assert.ok(d.content.startsWith(`<cross-session-message from-name="${from}">\nAgent mailbox delivery`), d.content.slice(0, 200));
    assert.ok(d.content.endsWith('\n</cross-session-message>'));
    assert.match(d.content, new RegExp(`\\[mailbox\\] 3 new messages for ${address.replace(/\./g, '\\.')}:\\n`));
    assert.deepEqual(fake.messages().map((m) => [m.id, m.body, m.verified]), [[ids[0], 'one', 'alice'], [ids[1], 'two\nlines', 'alice'], [ids[2], 'three', 'alice']]);
    assert.match(d.content, new RegExp(`Reply with: mbox send ${from.replace(/\./g, '\\.')} --re ${ids[0]} "<text>"`));
    assert.match(d.content, /Untrusted content from another agent session/);
    await until(async () => (await ackPending(sid)) === 0, 'acked after delivery');

    // Singleton: a second daemon exits at once.
    const second = spawnSync(process.execPath, [MBOX, 'deliverd'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(second.status, 0);
    assert.match(logOf(env), /another deliverd is running \(pid \d+\); exiting/);
    // --status shows the session, never the token.
    const st = mbox(['deliverd', '--status'], { env });
    assert.match(st.stdout, new RegExp(`deliverd running \\(pid ${daemonPid(env)}\\)`));
    assert.ok(st.stdout.includes(address));
    for (const text of [st.stdout, logOf(env), fs.readFileSync(statePath(env, 'deliverd.out'), 'utf8')]) assert.ok(!text.includes(TOKEN), 'token leaked');
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
    const { address } = sessionStart(env, sid, projectDir('retry'), { socket: sock, hostPid: host.pid });
    await until(() => peers().includes(address), 'announced');
    const id = mail(address, 'while down');
    await until(() => /delivery failed \((ENOENT|ECONNREFUSED)\); retrying in/.test(logOf(env)), 'retry logged');
    await sleep(800);
    assert.ok((await ackPending(sid)) > 0, 'not acknowledged while undelivered');
    const fake = new FakeInbox(sock, { sessionId: sid, token: TOKEN });
    await fake.start();
    cleanup.push(() => fake.stop());
    await fake.waitFor((f) => f.messages().length === 1);
    assert.equal(fake.messages()[0].id, id);
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
    const { address } = sessionStart(env, sid, projectDir('host'), { socket: fake.path, hostPid: host.pid });
    await until(() => peers().includes(address), 'announced');
    host.kill('SIGKILL');
    await until(() => !fs.existsSync(statePath(env, 'registrations', `${sid}.json`)), 'deregistered');
    await until(() => !peers().includes(address), 'departed');
    assert.match(logOf(env), new RegExp(`${address.replace(/\./g, '\\.')}: session process ${host.pid} is gone; deregistered`));
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
    const { address } = sessionStart({ ...env, AGENT_MAILBOX_FAULT: 'crash-after-commit' }, sid, projectDir('restart'), { socket: fake.path, hostPid: host.pid });
    await until(() => peers().includes(address), 'announced');
    const first = daemonPid(env);
    const id = mail(address, 'exactly once');
    await fake.waitFor((f) => f.messages().length === 1);
    await until(() => !alive(first), 'daemon crashed after recording');
    assert.ok((await ackPending(sid)) > 0, 'killed before the acknowledgement');
    // Any mbox command (or the next session start) brings the daemon back.
    assert.equal(mbox(['--session', sid, 'whoami'], { env }).code, 0);
    await until(() => daemonPid(env) && daemonPid(env) !== first && alive(daemonPid(env)), 'daemon restarted');
    await until(async () => (await ackPending(sid)) === 0, 'redelivery recognised and acknowledged', 20000);
    const id2 = mail(address, 'next one');
    await fake.waitFor((f) => f.messages().length === 2);
    await sleep(500);
    assert.deepEqual(fake.messages().map((m) => m.id), [id, id2]);
  });

  it('runaway guard: at most AGENT_MAILBOX_MAX_PER_MIN per window, the rest held with one notice line', async () => {
    const env = bobMachine({ AGENT_MAILBOX_MAX_PER_MIN: '3', AGENT_MAILBOX_RATE_WINDOW_MS: '4000' });
    const sid = 'd-rate-5555';
    const fake = await inbox(sid);
    const host = fakeHost();
    const { address } = sessionStart(env, sid, projectDir('rate'), { socket: fake.path, hostPid: host.pid });
    await until(() => peers().includes(address), 'announced');
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5'].map((t) => mail(address, t));
    await fake.waitFor((f) => f.messages().length === 5, 15000);
    await sleep(500);
    const per = fake.delivered.map((d) => new Watcher.Parser(d.content).messages().length);
    assert.equal(per[0], 3, `first window: ${per}`);
    assert.equal(per.reduce((a, n) => a + n, 0), 5);
    assert.deepEqual(fake.messages().map((m) => m.id), ids, 'every message once, in order, each a complete block');
    const notices = fake.contents().join('\n').match(/^\[mailbox\] throttling: .*$/gm) || [];
    assert.equal(notices.length, 1, fake.contents().join('\n---\n'));
    assert.match(notices[0], /this session gets at most 3 messages per minute; /);
    assert.match(logOf(env), /: throttling, /);
  });

  it('runaway guard: mail already waiting beyond the limit is held with the notice in the same delivery', async () => {
    const env = bobMachine({ AGENT_MAILBOX_MAX_PER_MIN: '3', AGENT_MAILBOX_RATE_WINDOW_MS: '3000' });
    const sid = 'd-rate-5556';
    const fake = await inbox(sid);
    const { address } = sessionStart(env, sid, projectDir('rate2'), { socket: fake.path, hostPid: fakeHost().pid });
    await until(() => peers().includes(address), 'announced');
    assert.equal(mbox(['pause', address], { env }).code, 0);
    await sleep(400);
    const ids = ['q1', 'q2', 'q3', 'q4', 'q5'].map((t) => mail(address, t));
    await sleep(800);
    assert.equal(mbox(['resume', address], { env }).code, 0);
    await fake.waitFor((f) => f.delivered.length >= 1);
    await sleep(700);
    assert.equal(fake.delivered.length, 1, 'the excess waits for the next window');
    const first = fake.delivered[0].content;
    assert.equal(new Watcher.Parser(first).messages().length, 3);
    assert.match(first, /\n\[mailbox\] throttling: this session gets at most 3 messages per minute; 2 more messages are held and follow in the next window \(or read now: mbox inbox --since 10m\)\.\n<\/cross-session-message>$/);
    await fake.waitFor((f) => f.messages().length === 5, 10000);
    assert.deepEqual(fake.messages().map((m) => m.id), ids);
    assert.doesNotMatch(fake.delivered.at(-1).content, /throttling/);
    assert.match(logOf(env), /throttling, 2 held for the next window/);
  });

  it('mbox pause holds delivery (one session, or --all) until mbox resume', async () => {
    const env = bobMachine();
    const s1 = 'd-pause-6666';
    const s2 = 'd-pause-7777';
    const f1 = await inbox(s1);
    const f2 = await inbox(s2);
    const a1 = sessionStart(env, s1, projectDir('pause-a'), { socket: f1.path, hostPid: fakeHost().pid }).address;
    const a2 = sessionStart(env, s2, projectDir('pause-b'), { socket: f2.path, hostPid: fakeHost().pid }).address;
    await until(() => peers().includes(a1) && peers().includes(a2), 'announced');

    const p = mbox(['pause', a1], { env });
    assert.equal(p.code, 0, p.stderr);
    assert.match(p.stdout, new RegExp(`delivery paused for ${a1.replace(/\./g, '\\.')}`));
    await sleep(500);
    mail(a1, 'held for a1');
    mail(a2, 'free for a2');
    await f2.waitFor((f) => f.messages().length === 1);
    await sleep(1000);
    assert.equal(f1.delivered.length, 0, 'paused session gets nothing');
    assert.ok((await ackPending(s1)) > 0, 'held mail stays unacknowledged');
    assert.match(mbox(['deliverd', '--status'], { env }).stdout, new RegExp(`paused: ${a1.replace(/\./g, '\\.')}`));

    assert.equal(mbox(['pause', '--all'], { env }).code, 0);
    await sleep(500);
    mail(a2, 'held for a2');
    await sleep(1200);
    assert.equal(f2.messages().length, 1, '--all holds every session');

    const r = mbox(['resume'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /delivery resumed for all sessions on this machine.*Still paused: nothing/);
    await f1.waitFor((f) => f.messages().length === 1);
    await f2.waitFor((f) => f.messages().length === 2);
    assert.deepEqual(f1.messages().map((m) => m.body), ['held for a1']);
    assert.match(logOf(env), /delivery paused for all sessions[\s\S]*delivery not paused/);
    assert.ok(!fs.existsSync(statePath(env, 'paused.json')));
  });

  it('exits on its own once no session is registered (idle timeout)', async () => {
    const env = bobMachine({ AGENT_MAILBOX_DELIVERD_IDLE_MS: '1500' });
    const sid = 'd-idle-8888';
    const fake = await inbox(sid);
    const { address } = sessionStart(env, sid, projectDir('idle'), { socket: fake.path, hostPid: fakeHost().pid });
    await until(() => peers().includes(address), 'announced');
    const pid = daemonPid(env);
    await sleep(2500);
    assert.ok(alive(pid), 'stays while a session is registered');
    sessionEnd(env, sid);
    await until(() => !alive(pid), 'idle exit', 10000);
    assert.match(logOf(env), /stopping \(idle\)/);
    assert.equal(mbox(['deliverd', '--status'], { env }).stdout.split('\n')[0], 'deliverd not running');
  });
});
