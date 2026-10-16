// Integration-test harness: a REAL nats-server (JetStream, file storage) on a random 127.0.0.1 port
// with a temp config dir and store dir, provisioned by server/mbox-admin.sh exactly like production.
// Needs `nats-server` and the `nats` CLI on PATH (or NATS_SERVER_BIN / NATS_BIN); without them the
// integration suites are skipped, not failed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '@nats-io/transport-node';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MBOX = path.join(ROOT, 'adapters/claude-code/dist/mbox.mjs');
export const LAUNCHER = path.join(ROOT, 'adapters/claude-code/bin/mbox');
export const ADMIN = path.join(ROOT, 'server/mbox-admin.sh');
export const CONF_EXAMPLE = path.join(ROOT, 'server/nats-server.conf.example');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** -> {serverBin, natsBin} | {skip: reason} */
export function findServer() {
  const serverBin = process.env.NATS_SERVER_BIN || 'nats-server';
  const natsBin = process.env.NATS_BIN || 'nats';
  const a = spawnSync(serverBin, ['--version'], { encoding: 'utf8' });
  const b = spawnSync(natsBin, ['--version'], { encoding: 'utf8' });
  if (a.error || a.status !== 0) return { skip: 'nats-server not found (set NATS_SERVER_BIN)' };
  if (b.error || b.status !== 0) return { skip: 'nats CLI not found (set NATS_BIN)' };
  return { serverBin, natsBin };
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export class Broker {
  constructor(server, { presenceTtl = '30m', maxAge } = {}) {
    this.server = server;
    this.presenceTtl = presenceTtl;
    this.maxAge = maxAge;
    this.passwords = {};
    this.proc = null;
    this.dir = tmp('amb-nats-');
    this.confDir = path.join(this.dir, 'conf');
    this.storeDir = path.join(this.dir, 'store');
    fs.mkdirSync(this.confDir);
  }

  get configFile() {
    return path.join(this.confDir, 'nats-server.conf');
  }

  adminEnv() {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MBOX_CONF_DIR: this.confDir,
      NATS_URL: this.url,
      MBOX_PUBLIC_URL: this.url,
      MBOX_PRESENCE_TTL: this.presenceTtl,
      ...(this.maxAge ? { MBOX_MAX_AGE: this.maxAge } : {}),
      NATS_BIN: this.server.natsBin,
      NATS_SERVER_BIN: this.server.serverBin,
    };
  }

  /** Run server/mbox-admin.sh against this server. */
  admin(args, { check = true } = {}) {
    const r = spawnSync('/bin/sh', [ADMIN, ...args], { encoding: 'utf8', env: this.adminEnv() });
    if (check && r.status !== 0) throw new Error(`mbox-admin.sh ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
    return { code: r.status, out: r.stdout + r.stderr };
  }

  adminCreds() {
    const txt = fs.readFileSync(path.join(this.confDir, 'admin.creds'), 'utf8');
    return { user: txt.match(/^user=(.*)$/m)[1], pass: txt.match(/^password=(.*)$/m)[1] };
  }

  async init(users = ['alice', 'bob']) {
    this.port = await freePort();
    this.url = `nats://127.0.0.1:${this.port}`;
    // The production example with the machine-specific values swapped for temp ones.
    const conf = fs
      .readFileSync(CONF_EXAMPLE, 'utf8')
      .replace(/^listen: .*$/m, `listen: "127.0.0.1:${this.port}"`)
      .replace(/^http: .*$/m, '# http monitoring disabled in tests')
      .replace(/^pid_file: .*$/m, `pid_file: "${path.join(this.dir, 'nats.pid')}"`)
      .replace(/^(\s*)store_dir: .*$/m, `$1store_dir: "${this.storeDir}"`);
    fs.writeFileSync(this.configFile, conf);
    this.admin(['init']); // server not running yet: writes users.conf + admin creds
    await this.start();
    this.admin(['init']); // now creates MBX_ALL and the presence bucket
    for (const u of users) this.addUser(u);
  }

  addUser(u) {
    const { out } = this.admin(['add-user', u]);
    const m = out.match(/printf '%s\\n' '([A-Za-z0-9]+)' \| mbox setup --servers (\S+) --user (\S+) --password-stdin/);
    if (!m) throw new Error(`no setup line in:\n${out}`);
    this.passwords[u] = m[1];
    return out;
  }

  async start() {
    this.proc = spawn(this.server.serverBin, ['-c', this.configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.log = '';
    this.proc.stderr.on('data', (d) => (this.log += d));
    const creds = this.adminCreds();
    for (let i = 0; i < 150; i++) {
      try {
        const nc = await connect({ servers: this.url, ...creds, reconnect: false, timeout: 500 });
        await nc.close();
        return;
      } catch {
        /* not up yet */
      }
      if (this.proc.exitCode !== null) throw new Error(`nats-server exited early:\n${this.log}`);
      await sleep(100);
    }
    throw new Error(`nats-server did not come up:\n${this.log}`);
  }

  async kill() {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
  }

  async stop() {
    await this.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** A raw client connection as a mailbox user (with that user's private inbox prefix) or the admin. */
  async conn(user) {
    const auth = user === 'admin' ? this.adminCreds() : { user, pass: this.passwords[user], inboxPrefix: `_INBOX_${user}` };
    return connect({ servers: this.url, ...auth, reconnect: false, timeout: 3000 });
  }
}

/** A throwaway "machine": private HOME/state/config so tests never touch the real ones. */
export function makeEnv(broker, user, extra = {}) {
  const home = tmp('amb-home-');
  return {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_MAILBOX_SERVERS: broker.url,
    AGENT_MAILBOX_USER: user,
    AGENT_MAILBOX_PASSWORD: broker.passwords[user],
    AGENT_MAILBOX_CONFIG: path.join(home, 'config.json'),
    AGENT_MAILBOX_STATE_DIR: path.join(home, 'state'),
    AGENT_MAILBOX_AGENT: 'claude-code', // explicit: tests don't run inside a detectable agent
    AGENT_MAILBOX_POLL_MS: '300',
    AGENT_MAILBOX_RESTORED_AFTER_MS: '300',
    AGENT_MAILBOX_MAX_BACKOFF_MS: '1500',
    ...extra,
  };
}

export function projectDir(name) {
  const d = path.join(tmp('amb-proj-'), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Run an mbox command to completion. */
export function mbox(args, { env, cwd, input, timeoutMs = 20000 } = {}) {
  const r = spawnSync(process.execPath, [MBOX, ...args], { env, cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const withSession = (env, session) => ({ ...env, AGENT_MAILBOX_SESSION: session });

export class Watcher {
  constructor(env, { cwd, session } = {}) {
    this.out = '';
    this.proc = spawn(process.execPath, [MBOX, 'watch'], {
      env: withSession(env, session),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exited = new Promise((r) => this.proc.once('exit', (code, signal) => r(code ?? signal)));
    this.proc.stdout.on('data', (d) => (this.out += d));
    this.err = '';
    this.proc.stderr.on('data', (d) => (this.err += d));
  }

  async waitFor(re, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = this.out.match(re);
      if (m) return m;
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) break;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${re}; stdout so far:\n${this.out.slice(0, 4000)}\nstderr:\n${this.err}`);
  }

  /** All "[mailbox] message <id> ..." blocks seen so far. */
  messages() {
    const out = [];
    const re = /\[mailbox\] message (\S+) from (.+?) to (\S+) \| subject: (.*?) \| verified-user: ([^\n]*)\n((?:\(sent [^\n]*\)\n)?)\([^\n]*\)\n([\s\S]*?)\n\[mailbox\] end \1\n/g;
    let m;
    while ((m = re.exec(this.out))) out.push({ id: m[1], from: m[2], to: m[3], subject: m[4], verified: m[5], stale: m[6].trim(), body: m[7] });
    return out;
  }

  async stop() {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGTERM');
    return this.exited;
  }
}

export function sessionAddr(env, session, cwd) {
  const r = mbox(['whoami'], { env: withSession(env, session), cwd });
  if (r.code !== 0) throw new Error(`whoami failed: ${r.stderr}`);
  return r.stdout.split('\n')[0].trim();
}

export function send(env, session, cwd, to, text, extra = []) {
  return mbox(['send', to, ...extra, text], { env: withSession(env, session), cwd });
}
