// `mbox wait` (the generic fallback receiver: a background task, or a hook) against a real nats-server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before } from 'node:test';
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import { consumerName } from '../src/core/transport/nats.js';
import {
  Broker,
  Waiter,
  Watcher,
  at,
  findServer,
  makeEnv,
  mbox,
  projectDir,
  send,
  sessionAddr,
  sleep,
  waitForWaiter,
  type MachineEnv,
  type WaiterOptions,
} from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();

describe('mbox wait', { skip: SERVER.skip }, () => {
  let b: Broker;
  let aliceEnv: MachineEnv;
  let bobEnv: MachineEnv;
  let adminNc: NatsConnection;
  let jsm: JetStreamManager;
  const procs: Array<Watcher | Waiter> = [];
  const track = <P extends Watcher | Waiter>(p: P): P => (procs.push(p), p);
  const bodies = (w: Watcher | Waiter): string[] => w.messages().map((m) => m.body);
  const peers = (): string => mbox(['peers'], { env: aliceEnv }).stdout;
  const ackPending = async (sid: string): Promise<number> =>
    (await jsm.consumers.info('MBX_BOB', consumerName(sid))).num_ack_pending;
  const waiter = (
    env: MachineEnv,
    session: string,
    cwd: string,
    maxWait = '30',
    extra: WaiterOptions = {},
  ): Waiter => track(new Waiter(env, { session, cwd, args: ['--max-wait', maxWait], ...extra }));
  const mail = (to: string, text: string, from = 'alice-w'): void =>
    assert.equal(send(aliceEnv, from, projectDir('alice-w'), to, text).code, 0);

  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
    bobEnv = makeEnv(b, 'bob');
    adminNc = await b.conn('admin');
    jsm = await jetstreamManager(adminNc);
  });
  after(async () => {
    await Promise.all(procs.map((p) => p.stop().catch(() => {})));
    await adminNc?.close();
    await b?.stop();
  });

  it('exits 2 with all queued mail as one batch on stderr; acked, so the next waiter has nothing', async () => {
    const dir = projectDir('queued');
    const addr = sessionAddr(bobEnv, 'w-queued', dir);
    for (const t of ['one', 'two\nlines', 'three']) mail(addr, t);
    const w = waiter(bobEnv, 'w-queued', dir);
    assert.equal(await w.result(), 2, w.err);
    assert.ok(
      w.err.startsWith(
        `[mailbox] 3 new messages for ${addr} (mail delivery, not an error):\n[mailbox] message `,
      ),
      w.err,
    );
    assert.deepEqual(bodies(w), ['one', 'two\nlines', 'three']);
    assert.equal(at(w.messages(), 0).verified, 'alice');
    assert.equal(w.out, '');
    assert.equal(await ackPending('w-queued'), 0);
    const w2 = waiter(bobEnv, 'w-queued', dir, '2');
    assert.equal(await w2.result(), 0);
    assert.equal(w2.err, '');
  });

  it('blocks until mail arrives, then exits 2', async () => {
    const dir = projectDir('later');
    const addr = sessionAddr(bobEnv, 'w-later', dir);
    const w = waiter(bobEnv, 'w-later', dir);
    await sleep(1500);
    assert.ok(w.running, 'still waiting');
    assert.equal(w.err, '');
    mail(addr, 'arrived later');
    assert.equal(await w.result(), 2, w.err);
    assert.deepEqual(bodies(w), ['arrived later']);
  });

  it('a newer waiter supersedes an older one (older exits 0 silently); mail is delivered once', async () => {
    const dir = projectDir('supersede');
    const addr = sessionAddr(bobEnv, 'w-sup', dir);
    const w1 = waiter(bobEnv, 'w-sup', dir);
    await waitForWaiter(bobEnv, 'w-sup', w1.proc.pid);
    const w2 = waiter(bobEnv, 'w-sup', dir);
    assert.equal(await w1.result(5000), 0);
    assert.equal(w1.err, '');
    await waitForWaiter(bobEnv, 'w-sup', w2.proc.pid);
    await sleep(500);
    mail(addr, 'for the newest');
    assert.equal(await w2.result(), 2, w2.err);
    assert.deepEqual(bodies(w2), ['for the newest']);
    const w3 = waiter(bobEnv, 'w-sup', dir, '2');
    assert.equal(await w3.result(), 0);
    assert.equal(w3.err, '');
  });

  it('a live watch takes precedence: wait exits 0 at once and the watcher delivers', async () => {
    const dir = projectDir('watchfirst');
    const addr = sessionAddr(bobEnv, 'w-wf', dir);
    const watcher = track(new Watcher(bobEnv, { cwd: dir, session: 'w-wf' }));
    await watcher.waitFor(/online as/);
    mail(addr, 'to the watcher');
    const w = waiter(bobEnv, 'w-wf', dir);
    assert.equal(await w.result(5000), 0);
    assert.equal(w.err, '');
    await watcher.waitFor(/to the watcher/);
    await watcher.stop();
  });

  it('a watch that starts while a waiter runs makes it exit 0; nothing is delivered twice', async () => {
    const dir = projectDir('watchlater');
    const addr = sessionAddr(bobEnv, 'w-wl', dir);
    const w = waiter(bobEnv, 'w-wl', dir);
    await waitForWaiter(bobEnv, 'w-wl', w.proc.pid);
    const watcher = track(new Watcher(bobEnv, { cwd: dir, session: 'w-wl' }));
    assert.equal(await w.result(5000), 0);
    assert.equal(w.err, '');
    await watcher.waitFor(/online as/);
    mail(addr, 'only once');
    await watcher.waitFor(/only once/);
    await sleep(800);
    assert.deepEqual(bodies(watcher), ['only once']);
    await watcher.stop();
  });

  it('killed after writing but before acking: the next waiter delivers it again', async () => {
    const dir = projectDir('crash');
    const env = { ...bobEnv, AGENT_MAILBOX_REDELIVER_MS: '1500' };
    const addr = sessionAddr(env, 'w-crash', dir);
    const w1 = waiter({ ...env, AGENT_MAILBOX_FAULT: 'crash-after-write' }, 'w-crash', dir);
    await waitForWaiter(env, 'w-crash', w1.proc.pid);
    mail(addr, 'say it twice');
    assert.equal(await w1.result(), 'SIGKILL');
    assert.deepEqual(bodies(w1), ['say it twice']);
    assert.equal(await ackPending('w-crash'), 1);
    const w2 = waiter(env, 'w-crash', dir);
    assert.equal(await w2.result(), 2, w2.err);
    assert.deepEqual(bodies(w2), ['say it twice']);
    assert.equal(await ackPending('w-crash'), 0);
    const w3 = waiter(env, 'w-crash', dir, '2');
    assert.equal(await w3.result(), 0);
  });

  it('is listed in presence while waiting, and departs when the host process exits', async () => {
    const dir = projectDir('host');
    const parent = spawn('sleep', ['60'], { stdio: 'ignore' });
    const env = { ...bobEnv, CLAUDE_PID: String(parent.pid), AGENT_MAILBOX_PID_CHECK_MS: '300' };
    const addr = sessionAddr(env, 'w-host', dir);
    const w = waiter(env, 'w-host', dir);
    let listed = false;
    for (let i = 0; i < 50 && !listed; i++) {
      listed = peers().includes(addr);
      if (!listed) await sleep(100);
    }
    assert.ok(listed, 'presence entry while waiting');
    parent.kill('SIGKILL');
    assert.equal(await w.result(5000), 0);
    assert.ok(!peers().includes(addr), 'presence entry deleted');
  });

  it('--max-wait: exits 0 quietly and stays listed (the next turn continues)', async () => {
    const dir = projectDir('maxwait');
    const addr = sessionAddr(bobEnv, 'w-max', dir);
    const t0 = Date.now();
    const w = waiter(bobEnv, 'w-max', dir, '1');
    assert.equal(await w.result(8000), 0);
    assert.ok(Date.now() - t0 >= 1000);
    assert.equal(w.err, '');
    assert.ok(peers().includes(addr), 'no depart on timeout');
    const bad = waiter(bobEnv, 'w-max', dir, 'soon');
    assert.equal(await bad.result(), 0);
    assert.match(bad.err, /--max-wait must be a positive number/);
  });

  it('caps a long body with a pointer to `mbox show <id>`, which prints it in full', async () => {
    const dir = projectDir('long');
    const addr = sessionAddr(bobEnv, 'w-long', dir);
    const body = 'x'.repeat(20000) + '\nTHE END';
    mail(addr, body);
    const w = waiter(bobEnv, 'w-long', dir);
    assert.equal(await w.result(), 2, w.err.slice(0, 500));
    assert.ok(w.err.length <= 8000, `stderr is ${w.err.length} chars`);
    const [m] = w.messages();
    assert.ok(m);
    assert.match(
      m.body,
      new RegExp(`\\n\\(truncated: \\d+ more characters\\. Full text: mbox show ${m.id}\\)$`),
    );
    assert.ok(!m.body.includes('THE END'));
    const show = mbox(['show', m.id], {
      env: { ...bobEnv, AGENT_MAILBOX_SESSION: 'w-long' },
      cwd: dir,
    });
    assert.equal(show.code, 0, show.stderr);
    assert.ok(show.stdout.includes(`${body}\n[mailbox] end ${m.id}\n`));
    const none = mbox(['show', 'no-such-id'], {
      env: { ...bobEnv, AGENT_MAILBOX_SESSION: 'w-long' },
      cwd: dir,
    });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no message no-such-id/);
  });

  it('mail that does not fit is left for the next waiter, each message delivered exactly once', async () => {
    const dir = projectDir('many');
    const env = { ...bobEnv, AGENT_MAILBOX_WAIT_MAX_CHARS: '3000' };
    const addr = sessionAddr(env, 'w-many', dir);
    const sent = Array.from({ length: 12 }, (_, i) => `msg ${i} ` + 'y'.repeat(600));
    for (const t of sent) mail(addr, t);
    const got: string[] = [];
    let rounds = 0;
    for (;;) {
      const w = waiter(env, 'w-many', dir, '3');
      const code = await w.result();
      if (code === 0) break;
      assert.equal(code, 2, w.err.slice(0, 500));
      assert.ok(w.err.length <= 3000, `stderr is ${w.err.length} chars`);
      got.push(...w.messages().map((m) => m.body.split(' ').slice(0, 2).join(' ')));
      if (++rounds === 1)
        assert.match(
          w.err,
          /\[mailbox\] \d+ more messages did not fit here; they arrive after this turn ends \(or read now: mbox inbox --since \d+m\)\.\n$/,
        );
      assert.ok(rounds < 12, 'converges');
    }
    assert.ok(rounds > 1, 'needed more than one batch');
    // Exactly once: nothing lost, nothing twice. The order is not asserted: mail left for the next
    // waiter comes back through the server's redelivery, which may put a message behind later ones
    // when the machine is slow.
    const want = sent.map((t) => t.split(' ').slice(0, 2).join(' '));
    assert.deepEqual([...got].sort(), [...want].sort());
  });

  it('--hook-stdin takes the session and cwd from the hook payload; empty or silent stdin does not block', async () => {
    const dir = projectDir('hookdir');
    const noSession = { ...bobEnv };
    const input = JSON.stringify({
      session_id: 'hookw-1234',
      cwd: dir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    const w = track(new Waiter(noSession, { args: ['--hook-stdin', '--max-wait', '30'], input }));
    await waitForWaiter(bobEnv, 'hookw-1234', w.proc.pid);
    const addr = sessionAddr(bobEnv, 'hookw-1234', projectDir('elsewhere'));
    assert.match(addr, /^bob\.[a-z0-9-]+\.hookdir-hook$/); // label from the payload's cwd
    mail(addr, 'via hook payload');
    assert.equal(await w.result(), 2, w.err);
    assert.deepEqual(bodies(w), ['via hook payload']);

    const empty = track(
      new Waiter(bobEnv, {
        session: 'hookw-1234',
        cwd: dir,
        args: ['--hook-stdin', '--max-wait', '30'],
        stdin: 'ignore',
      }),
    );
    await waitForWaiter(bobEnv, 'hookw-1234', empty.proc.pid, 3000);
    await empty.stop();
    const silent = track(
      new Waiter(bobEnv, {
        session: 'hookw-1234',
        cwd: dir,
        args: ['--hook-stdin', '--max-wait', '30'],
        stdin: 'pipe',
      }),
    ); // never closed
    await waitForWaiter(bobEnv, 'hookw-1234', silent.proc.pid, 5000);
    mail(addr, 'still works');
    assert.equal(await silent.result(), 2, silent.err);
    assert.deepEqual(bodies(silent), ['still works']);
  });

  it('broadcasts wake other sessions but not the sender', async () => {
    const dA = projectDir('bc-a');
    const dB = projectDir('bc-b');
    const aliceAddr = sessionAddr(aliceEnv, 'w-bc-a', dA);
    sessionAddr(bobEnv, 'w-bc-b', dB);
    const wa = waiter(aliceEnv, 'w-bc-a', dA);
    const wb = waiter(bobEnv, 'w-bc-b', dB);
    await Promise.all([
      waitForWaiter(aliceEnv, 'w-bc-a', wa.proc.pid),
      waitForWaiter(bobEnv, 'w-bc-b', wb.proc.pid),
    ]);
    assert.equal(send(aliceEnv, 'w-bc-a', dA, 'all', 'hello everyone').code, 0);
    assert.equal(await wb.result(), 2, wb.err);
    assert.deepEqual(bodies(wb), ['hello everyone']);
    assert.equal(at(wb.messages(), 0).to, 'all');
    assert.equal(at(wb.messages(), 0).verified, 'alice');
    await sleep(1000);
    assert.ok(wa.running, 'own broadcast does not wake the sender');
    assert.equal(send(bobEnv, 'w-bc-b', dB, aliceAddr, 'direct to alice').code, 0);
    assert.equal(await wa.result(), 2, wa.err);
    assert.deepEqual(bodies(wa), ['direct to alice']);
  });

  it('the session-end hook stops the waiter and removes the presence entry', async () => {
    const dir = projectDir('ended');
    const addr = sessionAddr(bobEnv, 'w-end', dir);
    const w = waiter(bobEnv, 'w-end', dir);
    await waitForWaiter(bobEnv, 'w-end', w.proc.pid);
    for (let i = 0; i < 50 && !peers().includes(addr); i++) await sleep(100);
    assert.ok(peers().includes(addr));
    const r = mbox(['hook', 'claude-code', 'session-end'], {
      env: bobEnv,
      input: JSON.stringify({
        session_id: 'w-end',
        cwd: dir,
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(await w.result(3000), 0);
    assert.equal(w.err, '');
    assert.ok(!peers().includes(addr), 'departed');
  });

  it('as a hook, does not wait where the host would block on it (`claude -p`, the desktop app); run directly, it always may', async () => {
    const dir = projectDir('headless');
    const addr = sessionAddr(bobEnv, 'w-p', dir);
    mail(addr, 'not now');
    const hookInput = JSON.stringify({ session_id: 'w-p', cwd: dir, hook_event_name: 'Stop' });
    for (const entry of ['sdk-cli', 'claude-desktop']) {
      const w = track(
        new Waiter(
          { ...bobEnv, CLAUDE_CODE_ENTRYPOINT: entry },
          { cwd: dir, args: ['--hook-stdin', '--max-wait', '30'], input: hookInput },
        ),
      );
      assert.equal(await w.result(3000), 0, entry);
      assert.equal(w.err, '', entry);
    }
    // A background task (no hook stdin) in the desktop app may wait: nothing is blocked on it.
    const later = waiter({ ...bobEnv, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, 'w-p', dir);
    assert.equal(await later.result(), 2, later.err);
    assert.deepEqual(bodies(later), ['not now']);
  });
});
