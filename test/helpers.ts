// Integration-test harness: a REAL nats-server (JetStream, file storage) on a random 127.0.0.1 port
// with a temp config dir and store dir, provisioned by server/mbox-admin.sh exactly like production.
// Needs `nats-server` and the `nats` CLI on PATH (or NATS_SERVER_BIN / NATS_BIN); without them the
// integration suites are skipped, not failed.
import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { Env } from '../src/core/types.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MBOX = path.join(ROOT, 'adapters/claude-code/dist/mbox.mjs');
export const LAUNCHER = path.join(ROOT, 'adapters/claude-code/bin/mbox');
export const ADMIN = path.join(ROOT, 'server/mbox-admin.sh');
export const CONF_EXAMPLE = path.join(ROOT, 'server/nats-server.conf.example');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `list[i]`, failing the test when there is no such element. */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined)
    throw new Error(`expected an element at index ${i}, but the list has ${list.length}`);
  return v;
}

/** What `mbox hook claude-code session-start` prints on stdout. */
export interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/** `JSON.parse` for a document of a shape the test knows (output of the code under test, or a file it wrote): the type is the test's claim, not checked. */
export const parseJson = <T>(text: string): T => JSON.parse(text) as T;

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** The nats-server and nats CLI binaries; `skip` is set (to the reason) when either is missing, so a suite can pass it to `describe`. */
export interface ServerInfo {
  serverBin: string;
  natsBin: string;
  skip?: string;
}

export function findServer(): ServerInfo {
  const serverBin = process.env.NATS_SERVER_BIN || 'nats-server';
  const natsBin = process.env.NATS_BIN || 'nats';
  const a = spawnSync(serverBin, ['--version'], { encoding: 'utf8' });
  const b = spawnSync(natsBin, ['--version'], { encoding: 'utf8' });
  if (a.error || a.status !== 0)
    return { serverBin, natsBin, skip: 'nats-server not found (set NATS_SERVER_BIN)' };
  if (b.error || b.status !== 0)
    return { serverBin, natsBin, skip: 'nats CLI not found (set NATS_BIN)' };
  return { serverBin, natsBin };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr === null || typeof addr === 'string') throw new Error('no TCP port');
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

/**
 * A file as an earlier release shipped it (`git show <tag>:<path>`), copied to a temp dir; `skip`
 * says why it is unavailable (a shallow clone without the tag) so a suite can pass it to describe.
 */
export function fromRelease(tag: string, file: string): { path: string; skip?: string } {
  const r = spawnSync('git', ['-C', ROOT, 'show', `${tag}:${file}`], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error)
    return { path: '', skip: `${tag} is not in this clone's git history (fetch the tags)` };
  const out = path.join(tmp(`amb-${tag}-`), path.basename(file));
  fs.writeFileSync(out, r.stdout, { mode: 0o755 });
  return { path: out };
}

export interface BrokerOptions {
  presenceTtl?: string;
  maxAge?: string;
  /** Provision with this copy of mbox-admin.sh (an older release's, see `fromRelease`). */
  adminScript?: string;
}

/** What `Broker.admin` returns: the script's exit code and its stdout and stderr together. */
export interface AdminResult {
  code: number | null;
  out: string;
}

export interface AdminCommandOptions {
  /** Throw when the script exits non-zero (default true). */
  check?: boolean;
  /** Extra environment for the script. */
  env?: Env;
}

export class Broker {
  readonly server: ServerInfo;
  readonly presenceTtl: string;
  readonly maxAge: string | undefined;
  /** The mbox-admin.sh that `admin` runs; tests may switch it (an upgrade). */
  adminScript: string;
  readonly passwords: Record<string, string> = {};
  proc: ChildProcessByStdio<null, null, Readable> | null = null;
  readonly dir = tmp('amb-nats-');
  readonly confDir = path.join(this.dir, 'conf');
  readonly storeDir = path.join(this.dir, 'store');
  /** Set by `init`. */
  port = 0;
  url = '';
  log = '';

  constructor(
    server: ServerInfo,
    { presenceTtl = '30m', maxAge, adminScript = ADMIN }: BrokerOptions = {},
  ) {
    this.server = server;
    this.presenceTtl = presenceTtl;
    this.maxAge = maxAge;
    this.adminScript = adminScript;
    fs.mkdirSync(this.confDir);
  }

  /** The password `addUser` generated for `user`. */
  password(user: string): string {
    const pw = this.passwords[user];
    if (pw === undefined) throw new Error(`no password for ${user}`);
    return pw;
  }

  get configFile(): string {
    return path.join(this.confDir, 'nats-server.conf');
  }

  adminEnv(): Env {
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
  admin(args: string[], { check = true, env = {} }: AdminCommandOptions = {}): AdminResult {
    const r = spawnSync('/bin/sh', [this.adminScript, ...args], {
      encoding: 'utf8',
      env: { ...this.adminEnv(), ...env },
    });
    if (check && r.status !== 0)
      throw new Error(
        `mbox-admin.sh ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`,
      );
    return { code: r.status, out: r.stdout + r.stderr };
  }

  adminCreds(): { user: string; pass: string } {
    const txt = fs.readFileSync(path.join(this.confDir, 'admin.creds'), 'utf8');
    const user = /^user=(.*)$/m.exec(txt)?.[1];
    const pass = /^password=(.*)$/m.exec(txt)?.[1];
    if (user === undefined || pass === undefined)
      throw new Error('admin.creds has no user= and password= lines');
    return { user, pass };
  }

  async init(users: string[] = ['alice', 'bob']): Promise<void> {
    this.port = await freePort();
    this.url = `nats://127.0.0.1:${this.port}`;
    // The production example with the machine-specific values swapped for temp ones.
    const conf = fs
      .readFileSync(CONF_EXAMPLE, 'utf8')
      .replace(/^listen: .*$/m, `listen: "127.0.0.1:${this.port}"`)
      .replace(/^http: .*$/m, '# http monitoring disabled in tests')
      .replace(/^pid_file: .*$/m, `pid_file: "${this.pidFile}"`)
      .replace(/^(\s*)store_dir: .*$/m, `$1store_dir: "${this.storeDir}"`);
    fs.writeFileSync(this.configFile, conf);
    this.admin(['init']); // server not running yet: writes users.conf + admin creds
    await this.start();
    // Now creates MBX_ALL and the presence bucket. users.conf is unchanged since the first run, so the
    // script must not reload the server (a stream created while the server is still applying a
    // reload could be lost when it finishes); test/isolation.test.ts proves it does not.
    this.admin(['init']);
    for (const u of users) this.addUser(u);
  }

  addUser(u: string): string {
    const { out } = this.admin(['add-user', u]);
    const password =
      /printf '%s\\n' '([A-Za-z0-9]+)' \| mbox setup --servers (\S+) --user (\S+) --password-stdin/.exec(
        out,
      )?.[1];
    if (password === undefined) throw new Error(`no setup line in:\n${out}`);
    this.passwords[u] = password;
    return out;
  }

  get pidFile(): string {
    return path.join(this.dir, 'nats.pid');
  }

  /** Send the server one reload signal (what mbox-admin.sh does), without waiting for it. */
  reload(): void {
    const pid = fs.readFileSync(this.pidFile, 'utf8').trim();
    const r = spawnSync(this.server.serverBin, ['--signal', `reload=${pid}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`reload signal failed: ${r.stderr}`);
  }

  async start(): Promise<void> {
    const proc = spawn(this.server.serverBin, ['-c', this.configFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.proc = proc;
    this.log = '';
    proc.stderr.on('data', (d: Buffer) => (this.log += d.toString()));
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
      if (proc.exitCode !== null) throw new Error(`nats-server exited early:\n${this.log}`);
      await sleep(100);
    }
    throw new Error(`nats-server did not come up:\n${this.log}`);
  }

  async kill(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
  }

  async stop(): Promise<void> {
    await this.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** A raw client connection as a mailbox user (with that user's private inbox prefix) or the admin. */
  async conn(user: string): Promise<NatsConnection> {
    const auth =
      user === 'admin'
        ? this.adminCreds()
        : { user, pass: this.password(user), inboxPrefix: `_INBOX_${user}` };
    return connect({ servers: this.url, ...auth, reconnect: false, timeout: 3000 });
  }
}

/** The environment of a throwaway "machine" (see `makeEnv`). */
export interface MachineEnv extends Env {
  HOME: string;
  AGENT_MAILBOX_CONFIG: string;
  AGENT_MAILBOX_STATE_DIR: string;
}

/** A throwaway "machine": private HOME/state/config so tests never touch the real ones. */
export function makeEnv(broker: Broker, user: string, extra: Env = {}): MachineEnv {
  const home = tmp('amb-home-');
  return {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_MAILBOX_SERVERS: broker.url,
    AGENT_MAILBOX_USER: user,
    AGENT_MAILBOX_PASSWORD: broker.password(user),
    AGENT_MAILBOX_CONFIG: path.join(home, 'config.json'),
    AGENT_MAILBOX_STATE_DIR: path.join(home, 'state'),
    AGENT_MAILBOX_AGENT: 'claude-code', // explicit: tests don't run inside a detectable agent
    AGENT_MAILBOX_POLL_MS: '300',
    AGENT_MAILBOX_RESTORED_AFTER_MS: '300',
    AGENT_MAILBOX_MAX_BACKOFF_MS: '1500',
    ...extra,
  };
}

export function projectDir(name: string): string {
  const d = path.join(tmp('amb-proj-'), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export interface MboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface MboxOptions {
  env?: Env;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** Run this copy of the bundle instead of the repository's (another install path). */
  bundle?: string;
}

/** Run an mbox command to completion. */
export function mbox(
  args: string[],
  { env, cwd, input, timeoutMs = 20000, bundle = MBOX }: MboxOptions = {},
): MboxResult {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    env,
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const withSession = (env: Env, session: string | undefined): Env => ({
  ...env,
  AGENT_MAILBOX_SESSION: session,
});

/** One "[mailbox] message <id> ..." block, as `Watcher.messages()` parses it. */
export interface MailboxBlock {
  id: string;
  from: string;
  to: string;
  subject: string;
  /** The verified-user field (may carry a MISMATCH note). */
  verified: string;
  /** The "(sent ..., may be stale)" line, or ''. */
  stale: string;
  body: string;
}

/** How a child process ended: its exit code, or the signal that killed it. */
export type ExitStatus = number | NodeJS.Signals | null;

export interface WatcherOptions {
  cwd?: string;
  session?: string;
  /** Run this copy of the bundle (an older release's, see `fromRelease`). */
  bundle?: string;
}

/** Parses the "[mailbox] message" blocks out of some text. */
class BlockParser {
  constructor(private readonly text: string) {}

  messages(): MailboxBlock[] {
    const re =
      /\[mailbox\] message (\S+) from (.+?) to (\S+) \| subject: (.*?) \| verified-user: ([^\n]*)\n((?:\(sent [^\n]*\)\n)?)\([^\n]*\)\n([\s\S]*?)\n\[mailbox\] end \1\n/g;
    return [...this.text.matchAll(re)].map(
      ([, id = '', from = '', to = '', subject = '', verified = '', stale = '', body = '']) => ({
        id,
        from,
        to,
        subject,
        verified,
        stale: stale.trim(),
        body,
      }),
    );
  }
}

export class Watcher {
  static Parser = BlockParser;

  out = '';
  err = '';
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  readonly exited: Promise<ExitStatus>;

  constructor(env: Env, { cwd, session, bundle = MBOX }: WatcherOptions = {}) {
    this.proc = spawn(process.execPath, [bundle, 'watch'], {
      env: withSession(env, session),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.exited = new Promise((r) => this.proc.once('exit', (code, signal) => r(code ?? signal)));
    // Decode as a stream: a multi-byte character can straddle two pipe chunks (the chunk size
    // depends on the OS and its load), and `out += chunk` on raw Buffers would corrupt it.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => (this.out += d));
    this.proc.stderr.on('data', (d: string) => (this.err += d));
  }

  async waitFor(re: RegExp, timeoutMs = 15000): Promise<RegExpMatchArray> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = this.out.match(re);
      if (m) return m;
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) break;
      await sleep(50);
    }
    throw new Error(
      `timed out waiting for ${re}; stdout so far:\n${this.out.slice(0, 4000)}\nstderr:\n${this.err}`,
    );
  }

  /** All "[mailbox] message <id> ..." blocks seen so far. */
  messages(): MailboxBlock[] {
    return new BlockParser(this.out).messages();
  }

  async stop(): Promise<ExitStatus> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGTERM');
    return this.exited;
  }
}

export function sessionAddr(env: Env, session: string, cwd: string): string {
  const r = mbox(['whoami'], { env: withSession(env, session), cwd });
  if (r.code !== 0) throw new Error(`whoami failed: ${r.stderr}`);
  return (r.stdout.split('\n')[0] ?? '').trim();
}

export function send(
  env: Env,
  session: string,
  cwd: string,
  to: string,
  text: string,
  extra: string[] = [],
): MboxResult {
  return mbox(['send', to, ...extra, text], { env: withSession(env, session), cwd });
}

/** `mbox wait` as a child process: stderr is what the agent would see on exit 2. */
export interface WaiterOptions {
  cwd?: string;
  session?: string;
  args?: string[];
  /** Written to the waiter's stdin, which is then closed. */
  input?: string;
  /** What stdin is when there is no `input` (default 'ignore'; 'pipe' leaves it open and silent). */
  stdin?: 'ignore' | 'pipe';
}

export class Waiter {
  err = '';
  out = '';
  readonly proc: ChildProcess;
  readonly exited: Promise<ExitStatus>;

  constructor(env: Env, { cwd, session, args = [], input, stdin = 'ignore' }: WaiterOptions = {}) {
    const e = session ? withSession(env, session) : env;
    this.proc = spawn(process.execPath, [MBOX, 'wait', ...args], {
      env: e,
      cwd,
      stdio: [input !== undefined ? 'pipe' : stdin, 'pipe', 'pipe'],
    });
    if (input !== undefined) this.proc.stdin?.end(input);
    this.exited = new Promise((r) => this.proc.once('exit', (code, signal) => r(code ?? signal)));
    const { stdout, stderr } = this.proc;
    if (!stdout || !stderr) throw new Error('waiter has no stdout/stderr pipes');
    stdout.setEncoding('utf8'); // see Watcher: chunk boundaries can split a character
    stderr.setEncoding('utf8');
    stdout.on('data', (d: string) => (this.out += d));
    stderr.on('data', (d: string) => (this.err += d));
  }

  get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** The exit code (or signal), or 'still running' after timeoutMs. */
  result(timeoutMs = 15000): Promise<ExitStatus | 'still running'> {
    return Promise.race([
      this.exited,
      sleep(timeoutMs).then((): 'still running' => 'still running'),
    ]);
  }

  /** Message blocks on stderr. */
  messages(): MailboxBlock[] {
    return new BlockParser(this.err).messages();
  }

  async stop(): Promise<ExitStatus> {
    if (this.running) this.proc.kill('SIGKILL');
    return this.exited;
  }
}

/** Resolves once the lock file names `pid` (the process wrote it itself). */
async function waitForLockFile(
  file: string,
  pid: number | undefined,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown }).pid === pid) return; // our own lock file
    } catch {
      /* not yet */
    }
    await sleep(50);
  }
  throw new Error(`${what} ${pid} never held the lock ${file}`);
}

const sessionFile = (env: Env, name: string): string =>
  path.join(env.AGENT_MAILBOX_STATE_DIR ?? '', 'sessions', name);

/** The waiter lock file says this pid is the session's current waiter. */
export const waitForWaiter = (
  env: Env,
  session: string,
  pid: number | undefined,
  timeoutMs = 10000,
): Promise<void> =>
  waitForLockFile(sessionFile(env, `${session}.wait.lock`), pid, 'waiter', timeoutMs);

/** The watch lock file says this pid is the session's watcher: it is up, and a waiter will see it. */
export const waitForWatcher = (
  env: Env,
  session: string,
  pid: number | undefined,
  timeoutMs = 20000,
): Promise<void> => waitForLockFile(sessionFile(env, `${session}.lock`), pid, 'watcher', timeoutMs);

/**
 * A stand-in for Claude Code's per-session inbox socket, mimicking what the Claude Code bundle does
 * (see src/agents/claude-inbox.ts): newline-delimited JSON; an optional first {"type":"auth"} line;
 * a {"type":"user"} line needs a non-empty string message.content and is dropped when its
 * session_id names another session; other lines are ignored; a connection that sends no complete
 * line within firstLineMs is closed; on the client's end it ends its side. It records everything.
 */
/** A `{"type":"user"}` line the fake inbox accepted. */
export interface InboxUserLine {
  type: 'user';
  session_id?: unknown;
  from?: unknown;
  message: { role?: unknown; content: string; [field: string]: unknown };
  [field: string]: unknown;
}

/** One message the fake inbox accepted. */
export interface InboxDelivery {
  content: string;
  msg: InboxUserLine;
  line: string;
  /** Was the connection's first line a valid auth line? */
  authed: boolean;
  authLine: string | null;
}

/** A line the fake inbox ignored. */
export interface InboxDrop {
  reason: 'unparseable' | 'type' | 'content' | 'session_id';
  line: string;
}

export interface FakeInboxOptions {
  sessionId?: string | null;
  token?: string | null;
  firstLineMs?: number;
  closeDelayMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class FakeInbox {
  readonly path: string;
  readonly sessionId: string | null;
  readonly token: string | null;
  readonly firstLineMs: number;
  /** How long to keep a connection open after reading it (a slow session); may be changed. */
  closeDelayMs: number;
  /** While set, connections that have been read stay open until it resolves (a delivery held in flight). */
  hold: Promise<void> | null = null;
  readonly delivered: InboxDelivery[] = [];
  readonly dropped: InboxDrop[] = [];
  connections = 0;
  server: net.Server | null = null;

  constructor(
    socketPath: string,
    {
      sessionId = null,
      token = null,
      firstLineMs = 30000,
      closeDelayMs = 0,
    }: FakeInboxOptions = {},
  ) {
    this.path = socketPath;
    this.sessionId = sessionId;
    this.token = token;
    this.firstLineMs = firstLineMs;
    this.closeDelayMs = closeDelayMs;
  }

  start(): Promise<this> {
    const server = net.createServer({ allowHalfOpen: true }, (c) => {
      this.connections++;
      c.setEncoding('utf8');
      let buf = '';
      let first = true;
      let authed = false;
      let authLine: string | null = null;
      let deadline: NodeJS.Timeout | null = setTimeout(() => c.destroy(), this.firstLineMs);
      const handle = (raw: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.dropped.push({ reason: 'unparseable', line: raw });
          return;
        }
        const j = isRecord(parsed) ? parsed : null;
        if (first && j?.type === 'auth') {
          authLine = raw;
          authed = this.token !== null && j.token === this.token;
          first = false;
          return;
        }
        first = false;
        if (j?.type !== 'user') {
          this.dropped.push({ reason: 'type', line: raw });
          return;
        }
        const message = j.message;
        const content = isRecord(message) ? message.content : undefined;
        if (typeof content !== 'string' || !content) {
          this.dropped.push({ reason: 'content', line: raw });
          return;
        }
        if (j.session_id !== undefined && this.sessionId && j.session_id !== this.sessionId) {
          this.dropped.push({ reason: 'session_id', line: raw });
          return;
        }
        // type, message and content were checked above
        this.delivered.push({ content, msg: j as InboxUserLine, line: raw, authed, authLine });
      };
      c.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (deadline) clearTimeout(deadline);
          deadline = null;
          if (line.trim()) handle(line);
        }
      });
      c.on('end', () => {
        if (buf.trim()) handle(buf);
        if (deadline) clearTimeout(deadline);
        if (this.hold) void this.hold.then(() => c.end());
        else if (this.closeDelayMs) setTimeout(() => c.end(), this.closeDelayMs).unref();
        else c.end();
      });
      c.on('error', () => {});
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => resolve(this));
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((r) => server.close(() => r()));
    this.server = null;
    fs.rmSync(this.path, { force: true });
  }

  contents(): string[] {
    return this.delivered.map((d) => d.content);
  }

  /** "[mailbox] message" blocks across all deliveries. */
  messages(): MailboxBlock[] {
    return new BlockParser(this.contents().join('\n')).messages();
  }

  async waitFor(pred: (inbox: this) => boolean, timeoutMs = 15000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this)) return;
      await sleep(50);
    }
    throw new Error(
      `fake inbox: condition not met in ${timeoutMs} ms; delivered:\n${this.contents().join('\n---\n').slice(0, 4000)}\ndropped: ${JSON.stringify(this.dropped).slice(0, 1000)}`,
    );
  }
}

/** A short directory for Unix sockets (macOS caps socket paths at about 104 bytes). */
export function socketDir(): string {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'mbx-'));
}
