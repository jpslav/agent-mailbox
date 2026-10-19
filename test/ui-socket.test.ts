// The delivery daemon's snapshot socket against a real nats-server: a session registered through
// the session-start hook gets snapshots over `<state>/ui.sock`, mail delivered to it invalidates
// them, `mbox snapshot --json` names the socket, and the socket goes with the daemon.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before } from 'node:test';
import type { Env, Snapshot } from '../src/core/types.js';
import {
  Broker,
  FakeInbox,
  findServer,
  makeEnv,
  mbox,
  parseJson,
  projectDir,
  send,
  sleep,
  socketDir,
  type HookOutput,
  type MachineEnv,
} from './helpers.js';
import { describe, it } from './suite.js';

const SERVER = findServer();
const TOKEN = 'tok-ui-7d1e0c9b8a6f';

interface Got {
  status: number;
  etag: string | undefined;
  body: string;
}
function get(socketPath: string, url: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('snapshot socket in the delivery daemon', { skip: SERVER.skip }, () => {
  let b: Broker;
  let aliceEnv: MachineEnv;
  const cleanup: Array<() => Promise<unknown>> = [];
  const hosts: ChildProcess[] = [];
  before(async () => {
    b = new Broker(SERVER);
    await b.init(['alice', 'bob']);
    aliceEnv = makeEnv(b, 'alice');
  });
  after(async () => {
    for (const f of cleanup.reverse()) await f().catch(() => {});
    for (const h of hosts) h.kill('SIGKILL');
    await b?.stop();
  });

  const until = async (fn: () => unknown, what: string, timeoutMs = 20000): Promise<void> => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(50))
      if (await fn()) return;
    throw new Error(`timed out: ${what}`);
  };
  const daemonPid = (env: MachineEnv): number | null => {
    try {
      const file = path.join(env.AGENT_MAILBOX_STATE_DIR, 'deliverd.lock');
      return parseJson<{ pid: number }>(fs.readFileSync(file, 'utf8')).pid;
    } catch {
      return null;
    }
  };
  const alive = (pid: number | null): boolean => {
    try {
      return pid !== null && process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  const logOf = (env: MachineEnv): string => {
    try {
      return fs.readFileSync(path.join(env.AGENT_MAILBOX_STATE_DIR, 'deliverd.log'), 'utf8');
    } catch {
      return '';
    }
  };
  const stop = async (env: MachineEnv, sig: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    const pid = daemonPid(env);
    if (pid && alive(pid)) {
      process.kill(pid, sig);
      await until(() => !alive(pid), 'daemon exit', 15000);
    }
  };
  const machine = (): MachineEnv => {
    const env = makeEnv(b, 'bob', {
      AGENT_MAILBOX_PID_CHECK_MS: '300',
      AGENT_MAILBOX_DELIVERD_RESCAN_MS: '500',
    });
    cleanup.push(() => stop(env));
    return env;
  };
  const start = async (
    env: MachineEnv,
    sid: string,
  ): Promise<{ address: string; fake: FakeInbox }> => {
    const fake = new FakeInbox(path.join(socketDir(), 's.sock'), { sessionId: sid, token: TOKEN });
    await fake.start();
    cleanup.push(() => fake.stop());
    const host = spawn('sleep', ['600'], { stdio: 'ignore' });
    hosts.push(host);
    const r = mbox(['hook', 'claude-code', 'session-start'], {
      env: {
        ...env,
        CLAUDECODE: '1',
        CLAUDE_CODE_MESSAGING_SOCKET: fake.path,
        CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
        CLAUDE_PID: String(host.pid),
      },
      input: JSON.stringify({
        session_id: sid,
        cwd: projectDir('ui-sock'),
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_title: 'Panel test',
      }),
    });
    assert.equal(r.code, 0, r.stderr);
    const ctx = parseJson<HookOutput>(r.stdout).hookSpecificOutput.additionalContext;
    const address = /address is (\S+?)\. /.exec(ctx)?.[1] ?? '';
    assert.ok(address, ctx);
    await until(() => logOf(env).includes(`serving ${address}`), 'daemon serves the session');
    return { address, fake };
  };
  const sockOf = (env: Env & { AGENT_MAILBOX_STATE_DIR: string }): string =>
    path.join(env.AGENT_MAILBOX_STATE_DIR, 'ui.sock');

  it('serves a registered session (0600 socket, 0700 directory); 404 otherwise; ETag and 304; delivery invalidates', async () => {
    const env = machine();
    const sid = 'ui-sock-1111';
    const { address, fake } = await start(env, sid);
    const sock = sockOf(env);
    await until(() => logOf(env).includes('serving snapshots on'), 'socket served');
    assert.ok(fs.lstatSync(sock).isSocket());
    assert.equal(fs.lstatSync(sock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(env.AGENT_MAILBOX_STATE_DIR).mode & 0o077, 0);

    const url = `/v1/snapshot?session=${sid}`;
    const first = await get(sock, url);
    assert.equal(first.status, 200, first.body);
    const snap = parseJson<Snapshot>(first.body);
    assert.equal(snap.self.address, address);
    assert.equal(snap.self.title, 'Panel test');
    assert.equal(snap.socket, sock);
    assert.ok(first.etag);
    assert.equal((await get(sock, url, { 'If-None-Match': first.etag })).status, 304);
    assert.equal((await get(sock, '/v1/snapshot?session=not-registered')).status, 404);

    // mbox snapshot --json in the session names the socket
    const cli = mbox(['snapshot', '--json'], { env: { ...env, AGENT_MAILBOX_SESSION: sid } });
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(parseJson<Snapshot>(cli.stdout).socket, sock);
    // ...and one that is not registered gets none
    const other = mbox(['snapshot', '--json'], {
      env: { ...env, AGENT_MAILBOX_SESSION: 'ui-other' },
    });
    assert.equal(parseJson<Snapshot>(other.stdout).socket, null);

    // mail delivered to the session: the next poll is a new snapshot with it
    const sent = send(aliceEnv, 'alice-ui', projectDir('alice-ui'), address, 'for the panel');
    assert.equal(sent.code, 0, sent.stderr);
    await fake.waitFor((f) => f.messages().some((m) => m.body.includes('for the panel')));
    const after = await get(sock, url, { 'If-None-Match': first.etag });
    assert.equal(after.status, 200);
    assert.deepEqual(
      parseJson<Snapshot>(after.body).mail.map((m) => m.body),
      ['for the panel'],
    );
    assert.equal((await get(sock, url, { 'If-None-Match': after.etag ?? '' })).status, 304);

    // the session ends: no longer served
    const end = mbox(['hook', 'claude-code', 'session-end'], {
      env: { ...env, CLAUDECODE: '1' },
      input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', reason: 'other' }),
    });
    assert.equal(end.code, 0, end.stderr);
    await until(async () => (await get(sock, url)).status === 404, 'deregistered: 404');
  });

  it("the socket goes with the daemon; a killed daemon's socket is replaced by the next one", async () => {
    const env = machine();
    const sid = 'ui-sock-2222';
    await start(env, sid);
    const sock = sockOf(env);
    await until(() => logOf(env).includes('serving snapshots on'), 'socket served');
    await stop(env, 'SIGTERM');
    assert.ok(!fs.existsSync(sock), 'removed on a clean stop');

    const env2 = machine();
    await start(env2, 'ui-sock-3333');
    const sock2 = sockOf(env2);
    await until(() => fs.existsSync(sock2), 'socket served');
    await stop(env2, 'SIGKILL');
    assert.ok(fs.lstatSync(sock2).isSocket(), 'a killed daemon leaves its socket behind');
    await start(env2, 'ui-sock-3333'); // the hook starts a new daemon
    await until(
      async () =>
        (await get(sock2, '/v1/snapshot?session=ui-sock-3333').catch(() => null))?.status === 200,
      'the new daemon serves',
    );
  });
});
