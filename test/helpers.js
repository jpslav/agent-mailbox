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
import { jetstreamManager } from '@nats-io/jetstream';
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
      MBOX_RELOAD_SETTLE: '0.2', // production waits 1 s after a reload; tests need not
      ...(this.maxAge ? { MBOX_MAX_AGE: this.maxAge } : {}),
      NATS_BIN: this.server.natsBin,
      NATS_SERVER_BIN: this.server.serverBin,
    };
  }

  /** Run server/mbox-admin.sh against this server. */
  admin(args, { check = true, env = {} } = {}) {
    const r = spawnSync('/bin/sh', [ADMIN, ...args], { encoding: 'utf8', env: { ...this.adminEnv(), ...env } });
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
    // Now creates MBX_ALL and the presence bucket. users.conf is unchanged since the first run, so the
    // script must not reload the server (a stream created while the server is still applying a
    // reload could be lost when it finishes); test/isolation.test.js proves it does not.
    this.admin(['init']);
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
        try {
          // Accepting connections is not enough: JetStream (recovering its streams after a restart,
          // slowly on a busy machine) must answer API requests before the suite may start.
          await (await jetstreamManager(nc, { checkAPI: false, timeout: 2000 })).getAccountInfo();
        } finally {
          await nc.close();
        }
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
    // Decode as a stream: a multi-byte character can straddle two pipe chunks (the chunk size
    // depends on the OS and its load), and `out += chunk` on raw Buffers would corrupt it.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
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
    return new Watcher.Parser(this.out).messages();
  }

  static Parser = class {
    constructor(text) {
      this.text = text;
    }

    messages() {
      const out = [];
      const re = /\[mailbox\] message (\S+) from (.+?) to (\S+) \| subject: (.*?) \| verified-user: ([^\n]*)\n((?:\(sent [^\n]*\)\n)?)\([^\n]*\)\n([\s\S]*?)\n\[mailbox\] end \1\n/g;
      let m;
      while ((m = re.exec(this.text))) out.push({ id: m[1], from: m[2], to: m[3], subject: m[4], verified: m[5], stale: m[6].trim(), body: m[7] });
      return out;
    }
  };

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

/** `mbox wait` as a child process: stderr is what the agent would see on exit 2. */
export class Waiter {
  constructor(env, { cwd, session, args = [], input, stdin = 'ignore' } = {}) {
    this.err = '';
    this.out = '';
    const e = session ? withSession(env, session) : env;
    this.proc = spawn(process.execPath, [MBOX, 'wait', ...args], { env: e, cwd, stdio: [input !== undefined ? 'pipe' : stdin, 'pipe', 'pipe'] });
    if (input !== undefined) this.proc.stdin.end(input);
    this.exited = new Promise((r) => this.proc.once('exit', (code, signal) => r(code ?? signal)));
    this.proc.stdout.setEncoding('utf8'); // see Watcher: chunk boundaries can split a character
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => (this.out += d));
    this.proc.stderr.on('data', (d) => (this.err += d));
  }

  get running() {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** The exit code (or signal), or 'still running' after timeoutMs. */
  result(timeoutMs = 15000) {
    return Promise.race([this.exited, sleep(timeoutMs).then(() => 'still running')]);
  }

  /** Message blocks on stderr. */
  messages() {
    return new Watcher.Parser(this.err).messages();
  }

  async stop() {
    if (this.running) this.proc.kill('SIGKILL');
    return this.exited;
  }
}

/** The waiter lock file says this pid is the session's current waiter. */
export async function waitForWaiter(env, session, pid, timeoutMs = 10000) {
  const file = path.join(env.AGENT_MAILBOX_STATE_DIR, 'sessions', `${session}.wait.lock`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) return;
    } catch { /* not yet */ }
    await sleep(50);
  }
  throw new Error(`waiter ${pid} never held the lock for ${session}`);
}

/**
 * A stand-in for Claude Code's per-session inbox socket, mimicking what the Claude Code bundle does
 * (see src/agents/claude-inbox.js): newline-delimited JSON; an optional first {"type":"auth"} line;
 * a {"type":"user"} line needs a non-empty string message.content and is dropped when its
 * session_id names another session; other lines are ignored; a connection that sends no complete
 * line within firstLineMs is closed; on the client's end it ends its side. It records everything.
 */
export class FakeInbox {
  constructor(socketPath, { sessionId = null, token = null, firstLineMs = 30000, closeDelayMs = 0 } = {}) {
    this.path = socketPath;
    this.sessionId = sessionId;
    this.token = token;
    this.firstLineMs = firstLineMs;
    this.closeDelayMs = closeDelayMs; // how long to keep a connection open after reading it (a slow session)
    this.delivered = []; // {content, line, authed, authLine}
    this.dropped = []; // {reason, line}
    this.connections = 0;
    this.server = null;
  }

  start() {
    this.server = net.createServer({ allowHalfOpen: true }, (c) => {
      this.connections++;
      c.setEncoding('utf8');
      let buf = '';
      let first = true;
      let authed = false;
      let authLine = null;
      let deadline = setTimeout(() => c.destroy(), this.firstLineMs);
      const handle = (raw) => {
        let j;
        try { j = JSON.parse(raw); } catch { this.dropped.push({ reason: 'unparseable', line: raw }); return; }
        if (first && j?.type === 'auth') {
          authLine = raw;
          authed = this.token !== null && j.token === this.token;
          first = false;
          return;
        }
        first = false;
        if (j?.type !== 'user') { this.dropped.push({ reason: 'type', line: raw }); return; }
        const content = j.message?.content;
        if (typeof content !== 'string' || !content) { this.dropped.push({ reason: 'content', line: raw }); return; }
        if (j.session_id !== undefined && this.sessionId && j.session_id !== this.sessionId) { this.dropped.push({ reason: 'session_id', line: raw }); return; }
        this.delivered.push({ content, msg: j, line: raw, authed, authLine });
      };
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          clearTimeout(deadline);
          deadline = null;
          if (line.trim()) handle(line);
        }
      });
      c.on('end', () => {
        if (buf.trim()) handle(buf);
        clearTimeout(deadline);
        if (this.closeDelayMs) setTimeout(() => c.end(), this.closeDelayMs).unref();
        else c.end();
      });
      c.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, () => resolve(this));
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(() => r()));
    this.server = null;
    fs.rmSync(this.path, { force: true });
  }

  contents() {
    return this.delivered.map((d) => d.content);
  }

  /** "[mailbox] message" blocks across all deliveries. */
  messages() {
    return new Watcher.Parser(this.contents().join('\n')).messages();
  }

  async waitFor(pred, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this)) return;
      await sleep(50);
    }
    throw new Error(`fake inbox: condition not met in ${timeoutMs} ms; delivered:\n${this.contents().join('\n---\n').slice(0, 4000)}\ndropped: ${JSON.stringify(this.dropped).slice(0, 1000)}`);
  }
}

/** A short directory for Unix sockets (macOS caps socket paths at about 104 bytes). */
export function socketDir() {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'mbx-'));
}
