import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { adapters, getAdapter, resolveAgent, resolveSession } from './agents/index.js';
import type { HookContext, HookInput, ResolvedSession } from './agents/index.js';
import { BROADCAST, fitLabel, isAddr, parseAddr, shortHost } from './core/addr.js';
import { ConfigError, configPath, loadConfig, splitServers, writeConfig } from './core/config.js';
import { buildEnvelope, formatBlock, oneLine, parseDelivery } from './core/envelope.js';
import { fileLog, runDeliverd } from './core/deliverd.js';
import { GUIDE_SECTIONS, guideText } from './core/guide.js';
import { pause, readPause, resume } from './core/pause.js';
import {
  deliverdLogPath,
  deliverdPid,
  deregister,
  ensureDeliverd,
  listRegistrations,
  register,
} from './core/registrations.js';
import { ResolveError, presenceRecord, resolveTarget } from './core/registry.js';
import { NoSessionError, ensureSession, pidAlive, readState, updateState } from './core/state.js';
import { createTransport, explainError, validateServer } from './core/transport/nats.js'; // composition root: the only place that picks the broker
import type {
  Config,
  PresenceEntry,
  SessionState,
  Transport,
  TransportOptions,
} from './core/types.js';
import type { PauseState } from './core/pause.js';
import { MAX_WAIT_MS, endSession, runWait } from './core/wait.js';
import { runWatch } from './core/watch.js';

class UsageError extends Error {}

const here = path.dirname(fileURLToPath(import.meta.url));
function launcherPath(): string {
  for (const rel of ['../bin/mbox', '../adapters/claude-code/bin/mbox']) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(p)) return p;
  }
  return 'mbox';
}

// The delivery daemon: `node <this bundle> deliverd`, started detached when sessions need it.
const deliverdArgv = (): string[] => [process.execPath, fileURLToPath(import.meta.url), 'deliverd'];
const sessionEnvVars = (): string[] => [
  'AGENT_MAILBOX_SESSION',
  ...adapters.flatMap((a) => a.delivery?.sessionEnv || []),
];
const startDeliverd = () =>
  ensureDeliverd(deliverdArgv(), process.env, { dropEnv: sessionEnvVars() });
/** Bring the daemon back if sessions are registered but it is not running (it may have crashed). */
function reviveDeliverd(): void {
  try {
    if (!deliverdPid() && listRegistrations().length) startDeliverd();
  } catch {
    /* best effort */
  }
}

// Every transport created by a command; closed before the process exits.
const transports: Transport[] = [];
function openTransport(cfg: Config, opts?: TransportOptions): Transport {
  const t = createTransport(cfg, opts);
  transports.push(t);
  return t;
}
/**
 * Let pending stdout/stderr writes finish before process.exit(): into a pipe that is full (macOS
 * pipes hold only 16 KB at first) Node queues the rest of a large write, and exiting would cut it off.
 */
const flushStdio = (): Promise<unknown> =>
  Promise.all(
    [process.stdout, process.stderr].map((s) => new Promise<void>((r) => s.write('', () => r()))),
  );
const closeTransports = (): Promise<unknown> =>
  Promise.all(transports.map((t) => t.close().catch(() => {})));

/** The `message` of a thrown value (printed as is, as for any Error). */
const errMessage = (e: unknown): string => (e as Error).message;

async function fail(e: unknown): Promise<never> {
  const msg =
    e instanceof ConfigError ||
    e instanceof NoSessionError ||
    e instanceof UsageError ||
    e instanceof ResolveError
      ? e.message
      : explainError(e);
  process.stderr.write(`mbox: ${msg}\n`);
  await closeTransports();
  process.exit(e instanceof UsageError ? 2 : 1);
}

/** The options every command accepts. */
interface GlobalOptions {
  session?: string;
  agent?: string;
}

const program = new Command();
const globalOpts = (): GlobalOptions => program.opts<GlobalOptions>();
program
  .name('mbox')
  .description('Agent mailbox: messages between agent sessions (broker-backed)')
  .option(
    '--session <id>',
    'agent session id (default: $AGENT_MAILBOX_SESSION, then the detected agent adapter)',
  )
  .option(
    '--agent <id>',
    'agent adapter id (default: $AGENT_MAILBOX_AGENT, then auto-detected, else "unknown")',
  );

/** What most commands start from. */
interface BaseContext {
  cfg: Config;
  transport: Transport;
  /** The agent id. */
  agent: string;
}

/** A BaseContext for one session, which now has an address. */
interface SessionContext extends BaseContext {
  sid: string;
  st: SessionState;
  hostPid: number | null;
}

async function context(opts: { needSession: false }): Promise<BaseContext>;
async function context(opts?: { needSession?: true }): Promise<SessionContext>;
async function context({ needSession = true }: { needSession?: boolean } = {}): Promise<
  BaseContext | SessionContext
> {
  const cfg = loadConfig();
  reviveDeliverd();
  const transport = openTransport(cfg);
  const agent = resolveAgent({ agent: globalOpts().agent });
  if (!needSession) return { cfg, transport, agent: agent.id };
  const { sid, hostPid } = resolveSession({ session: globalOpts().session, agent });
  const st = await ensureSession({ sid, cfg, transport, cwd: process.cwd(), hostPid });
  return { cfg, transport, sid, st, agent: agent.id, hostPid };
}

const action =
  <A extends unknown[]>(fn: (...args: A) => void | Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      await fail(e);
    }
    await closeTransports();
    await flushStdio();
    process.exit(process.exitCode ?? 0);
  };

// ---------------------------------------------------------------- whoami
program
  .command('whoami')
  .description("print this session's mailbox address")
  .action(
    action(async () => {
      const { st } = await context();
      console.log(st.address);
      if (st.aliases.length) console.log(`aliases: ${st.aliases.join(', ')}`);
    }),
  );

// ---------------------------------------------------------------- watch
program
  .command('watch')
  .description(
    "stream incoming messages to stdout (for an agent feature that turns a background process's output into notifications)",
  )
  .action(async () => {
    let cfg: Config;
    let session: ResolvedSession;
    const agent = resolveAgent({ agent: globalOpts().agent });
    try {
      cfg = loadConfig();
      session = resolveSession({ session: globalOpts().session, agent });
    } catch (e) {
      // As a monitor, one clear line then a clean exit beats a stack trace.
      process.stdout.write(`[mailbox] not running: ${errMessage(e)}\n`);
      process.exit(0);
    }
    try {
      const code = await runWatch({
        cfg,
        transport: openTransport(cfg),
        sid: session.sid,
        agent: agent.id,
        hostPid: session.hostPid,
      });
      process.exit(code);
    } catch (e) {
      process.stdout.write(`[mailbox] watcher failed: ${explainError(e)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- wait
/** A hook's stdin JSON, or {}: never blocks on a terminal, gives up on a pipe that stays silent. */
function readHookStdin(timeoutMs: number): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise<Record<string, unknown>>((resolve) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        resolve(j && typeof j === 'object' ? (j as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

program
  .command('wait')
  .description(
    'wait for mail, print it on stderr as one batch and exit 2; exit 0 when none came (fallback receiver: run it as a background task)',
  )
  .option('--hook-stdin', 'read the agent hook JSON on stdin (session id, cwd)')
  .option(
    '--max-wait <seconds>',
    'exit 0 after this long without mail (keep it below the hook timeout)',
    '540',
  )
  .action(async (opts: { hookStdin?: boolean; maxWait: string }) => {
    // An agent hook: never a stack trace, never a failing status. 2 means "mail on stderr".
    const quit: (msg?: string) => never = (msg) => {
      if (msg) process.stderr.write(`mbox wait: ${msg}\n`);
      process.exit(0);
    };
    const seconds = Number(opts.maxWait);
    if (!Number.isFinite(seconds) || seconds <= 0)
      quit(`--max-wait must be a positive number of seconds (got "${opts.maxWait}")`);
    const agent = resolveAgent({ agent: globalOpts().agent });
    const input = opts.hookStdin ? await readHookStdin(2000) : {};
    const hook: Partial<HookInput> = agent.adapter?.hookInput?.(input) || {};
    // Only a hook can stall its host; run directly (e.g. as a background task) it may always wait.
    if (opts.hookStdin && agent.adapter?.canWait && !agent.adapter.canWait(process.env)) quit();
    let cfg: Config;
    let session: ResolvedSession;
    try {
      cfg = loadConfig();
      session = resolveSession({
        session: globalOpts().session,
        agent,
        hookSession: hook.sessionId,
      });
    } catch (e) {
      quit(errMessage(e));
    }
    try {
      const result = await runWait({
        cfg,
        transport: openTransport(cfg),
        sid: session.sid,
        agent: agent.id,
        hostPid: session.hostPid,
        cwd: hook.cwd || process.cwd(),
        maxWaitMs: Math.min(seconds * 1000, MAX_WAIT_MS),
        write: (text) =>
          new Promise((resolve, reject) =>
            process.stderr.write(text, (err) => (err ? reject(err) : resolve())),
          ),
      });
      await closeTransports();
      process.exit(result === 'mail' ? 2 : 0);
    } catch (e) {
      quit(explainError(e));
    }
  });

// ---------------------------------------------------------------- deliverd
program
  .command('deliverd')
  .description(
    'the delivery daemon: pushes mail into registered agent sessions (started automatically by the session-start hook)',
  )
  .option('--status', 'print whether it runs and which sessions are registered, then exit')
  .action(async (opts: { status?: boolean }) => {
    if (opts.status) {
      const pid = deliverdPid();
      console.log(pid ? `deliverd running (pid ${pid})` : 'deliverd not running');
      const regs = listRegistrations();
      if (!regs.length) console.log('no registered sessions');
      for (const r of regs) {
        const host = r.hostPid
          ? `pid ${r.hostPid}${pidAlive(r.hostPid) ? '' : ' (gone)'}`
          : 'pid ?';
        console.log(
          `${oneLine(r.address, 140)}  ${oneLine(r.agent, 30)}  ${oneLine(r.endpoint.kind, 40)}  ${host}`,
        );
      }
      const p = readPause();
      if (p.all || p.addresses.length)
        console.log(`paused: ${pauseSummary(p)} (mbox resume to continue)`);
      console.log(`log: ${deliverdLogPath()}`);
      process.exit(0);
    }
    const log = fileLog(deliverdLogPath());
    let cfg: Config;
    try {
      cfg = loadConfig();
    } catch (e) {
      log(`not starting: ${errMessage(e)}`);
      process.exit(0);
    }
    process.on('unhandledRejection', (e) => log(`internal error (continuing): ${explainError(e)}`));
    process.on('uncaughtException', (e) => {
      log(`crashed: ${e?.stack?.split('\n').slice(0, 3).join(' | ') || e}`);
      process.exit(1);
    });
    const transport = openTransport(cfg, { multiplex: true });
    const code = await runDeliverd({
      cfg,
      transport,
      deliveryFor: (id) => getAdapter(id)?.delivery || null,
      log,
    });
    process.exit(code);
  });

// ---------------------------------------------------------------- pause / resume
/** A session on this machine by full address, or by unique label/prefix among the registered ones. */
function localAddress(input: string): string {
  if (isAddr(input)) return input;
  const names = listRegistrations().map((r) => r.address);
  // A registered address is a valid one (the session-start hook wrote it from the session's state).
  const labelOf = (n: string): string => parseAddr(n)!.label;
  const hits = names.filter(
    (n) => labelOf(n) === input || n.startsWith(input) || labelOf(n).startsWith(input),
  );
  const [only] = hits;
  if (hits.length === 1 && only !== undefined) return only;
  throw new UsageError(
    hits.length
      ? `"${input}" matches ${hits.length} sessions here: ${hits.join(', ')}`
      : `no session registered on this machine matches "${input}"; use a full address`,
  );
}
function thisAddress(): string {
  const { sid } = resolveSession({
    session: globalOpts().session,
    agent: resolveAgent({ agent: globalOpts().agent }),
  });
  const st = readState(sid);
  if (!st) throw new UsageError('this session has no mailbox address yet; name one, or use --all');
  return st.address;
}
const pauseSummary = (p: PauseState): string =>
  p.all ? 'all sessions on this machine' : p.addresses.length ? p.addresses.join(', ') : 'nothing';

program
  .command('pause')
  .description(
    'emergency stop: hold push delivery on this machine for this session, <address>, or --all (mail waits on the server)',
  )
  .argument(
    '[address]',
    'a session address (or unique label) on this machine; default: this session',
  )
  .option('--all', 'every session on this machine')
  .action(
    action((address: string | undefined, opts: { all?: boolean }) => {
      const target = opts.all ? null : address ? localAddress(address) : thisAddress();
      const p = pause({ all: !!opts.all, address: target });
      console.log(
        `delivery paused for ${opts.all ? 'all sessions on this machine' : target}; mail waits on the server. Paused now: ${pauseSummary(p)}. Undo with: mbox resume${opts.all ? '' : ` ${target}`}`,
      );
    }),
  );

program
  .command('resume')
  .description(
    'undo mbox pause: resume push delivery for <address>, or (no argument, or --all) for everything paused',
  )
  .argument('[address]', 'a session address (or unique label) on this machine')
  .option('--all', 'everything paused (the default without an address)')
  .action(
    action((address: string | undefined, opts: { all?: boolean }) => {
      const before = readPause();
      const target = address && !opts.all ? localAddress(address) : null;
      const p = resume({ all: !target, address: target });
      console.log(
        `delivery resumed for ${target || pauseSummary(before)}. Still paused: ${pauseSummary(p)}.`,
      );
      if (target && p.all)
        console.log('note: all sessions are still paused; run mbox resume --all to lift that.');
    }),
  );

// ---------------------------------------------------------------- guide
program
  .command('guide')
  .description(`short help on using the mailbox; sections: ${GUIDE_SECTIONS.join(', ')}`)
  .argument('[section]', 'which section (default: overview)')
  .action(async (section: string | undefined) => {
    const text = guideText(section);
    if (!text) {
      process.stderr.write(
        `mbox: no guide section "${oneLine(section, 40)}". Sections: ${GUIDE_SECTIONS.join(', ')}\n`,
      );
      await flushStdio();
      process.exit(2);
    }
    process.stdout.write(text);
    await flushStdio();
    process.exit(0);
  });

// ---------------------------------------------------------------- send
async function readStdin(timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer = timeoutMs
      ? setTimeout(
          () => reject(new UsageError('no message text given and nothing arrived on stdin')),
          timeoutMs,
        )
      : undefined;
    process.stdin.on('data', (c: Buffer) => {
      clearTimeout(timer);
      timer = undefined;
      chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', reject);
  });
}

program
  .command('send')
  .description(
    'send a message to a session address, a unique prefix/label of a live peer, or "all"',
  )
  .argument('<to>', 'full address, unique prefix/label of a live peer, or "all"')
  .argument('[text]', 'message text; "-" or omitted reads stdin')
  .option('--subject <s>', 'subject line')
  .option('--re <id>', 'id of the message this replies to')
  .action(
    action(
      async (to: string, text: string | undefined, opts: { subject?: string; re?: string }) => {
        const { cfg, transport, st, agent } = await context();
        let body = text;
        if (body === '-' || (body === undefined && !process.stdin.isTTY))
          body = await readStdin(body === undefined ? 3000 : 0);
        if (body === undefined || body === '')
          throw new UsageError('empty message: pass text as an argument or on stdin');

        let peers: PresenceEntry[] = [];
        let registryErr: unknown = null;
        try {
          peers = await transport.presence.list();
        } catch (e) {
          registryErr = e;
        }
        let target: { to: string; live: boolean };
        if (to === BROADCAST || (isAddr(to) && registryErr)) target = { to, live: true };
        else if (registryErr)
          throw new UsageError(
            `cannot resolve "${to}" without the peer registry (${explainError(registryErr)}); use a full address`,
          );
        else target = resolveTarget(to, peers);

        const envelope = buildEnvelope({
          from: st.address,
          to: target.to,
          agent,
          subject: opts.subject,
          body,
          inReplyTo: opts.re,
        });
        const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
        if (cfg.maxBytes && size > cfg.maxBytes) {
          throw new UsageError(
            `message is ${size} bytes as an envelope but your configured limit (AGENT_MAILBOX_MAX_BYTES / "maxMessageBytes") is ${cfg.maxBytes}. Shorten it or raise the limit.`,
          );
        }
        const res = await transport.publish(target.to, envelope);
        if (!target.live) {
          process.stderr.write(
            `warning: ${target.to} is not a live peer; the message is queued on the server (kept for the server's retention period, 180 days by default) until that session reads it.\n`,
          );
        }
        console.log(res.id);
      },
    ),
  );

// ---------------------------------------------------------------- peers
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

program
  .command('peers')
  .description('list live sessions from the presence registry')
  .action(
    action(async () => {
      const { transport } = await context({ needSession: false });
      const peers = (await transport.presence.list()).filter((p) => p.live);
      if (!peers.length) {
        console.log('no live peers');
        return;
      }
      const rows: string[][] = [['ADDRESS', 'ALIASES', 'AGENT', 'USER@HOST', 'CWD', 'LAST SEEN']];
      for (const p of peers) {
        rows.push([
          oneLine(p.address, 80),
          p.aliases.length ? p.aliases.map((a) => oneLine(a, 60)).join(',') : '-',
          oneLine(p.agent ?? '-', 30),
          `${oneLine(p.user ?? '?', 30)}@${oneLine(p.host ?? '?', 30)}`,
          oneLine(p.cwd ?? '-', 60),
          ago(p.lastSeen),
        ]);
      }
      // Every row has as many cells as the header.
      const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
      for (const r of rows)
        console.log(
          r
            .map((c, i) => c.padEnd(widths[i]!))
            .join('  ')
            .trimEnd(),
        );
    }),
  );

// ---------------------------------------------------------------- name
program
  .command('name')
  .description('add an alias address (<user>.<host>.<label>) for this session')
  .argument('<label>', 'new label, [a-z0-9-]+')
  .action(
    action(async (label: string) => {
      const { cfg, transport, sid, st, agent } = await context();
      if (!/^[a-z0-9-]+$/.test(label))
        throw new UsageError(`invalid label "${label}" (allowed: a-z 0-9 -)`);
      const me = parseAddr(st.address)!; // a session's address is a valid one: ensureSession built it
      const fitted = fitLabel(
        me.user,
        me.host,
        label,
        transport.limits.maxLabelLen(me.user, me.host),
      );
      if (fitted !== label)
        throw new UsageError(
          `label "${label}" is too long; the longest allowed here is "${fitted}" (${fitted.length} chars)`,
        );
      const alias = `${me.user}.${me.host}.${label}`;
      if (alias === st.address || st.aliases.includes(alias)) {
        console.log(alias);
        return;
      }
      try {
        const peers = await transport.presence.list();
        const clash = peers.find(
          (p) => p.live && p.session !== sid && (p.address === alias || p.aliases.includes(alias)),
        );
        if (clash)
          throw new UsageError(`${alias} is already used by live session ${clash.address}`);
      } catch (e) {
        if (e instanceof UsageError) throw e;
        process.stderr.write(
          `warning: could not check the registry for conflicts (${explainError(e)})\n`,
        );
      }
      const next = updateState(sid, (s) => {
        s.aliases.push(alias);
        return s;
      });
      await transport.presence
        .update(presenceRecord(next, { sid, cfg, agent }))
        .catch((e) =>
          process.stderr.write(`warning: could not announce alias (${explainError(e)})\n`),
        );
      console.log(alias);
    }),
  );

// ---------------------------------------------------------------- inbox
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
/** The milliseconds in a --since value; the caller has checked it matches /^\d+[smhd]$/. */
const sinceMs = (since: string): number =>
  parseInt(since, 10) * UNIT_MS[since.slice(-1) as keyof typeof UNIT_MS];

program
  .command('inbox')
  .description(
    'print recent messages (your addresses + broadcast) without moving the watcher cursor',
  )
  .option('--since <dur>', 'how far back (e.g. 30m, 2h, 1d)', '2h')
  .action(
    action(async (opts: { since: string }) => {
      if (!/^\d+[smhd]$/.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 1d (got "${opts.since}")`);
      const { cfg, transport, st } = await context();
      const names = [st.address, ...st.aliases];
      const deliveries = await transport.poll([...names, BROADCAST], {
        lookbackMs: sinceMs(opts.since),
      });
      let n = 0;
      for (const d of deliveries) {
        const m = parseDelivery(d);
        if (d.to === BROADCAST && m.sender === cfg.user && names.includes(m.from)) continue;
        process.stdout.write(formatBlock(m));
        n++;
      }
      if (!n) console.log(`no messages in the last ${opts.since}`);
    }),
  );

// ---------------------------------------------------------------- show
program
  .command('show')
  .description('print one message (to this session or a broadcast) in full, by its id')
  .argument('<id>', 'message id, as in "[mailbox] message <id>"')
  .option('--since <dur>', 'how far back to look (e.g. 2h, 7d)', '30d')
  .action(
    action(async (id: string, opts: { since: string }) => {
      if (!/^\d+[smhd]$/.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 7d (got "${opts.since}")`);
      const { transport, st } = await context();
      const deliveries = await transport.poll([st.address, ...st.aliases, BROADCAST], {
        lookbackMs: sinceMs(opts.since),
        max: Infinity,
      });
      const hit = deliveries.map(parseDelivery).find((m) => m.id === id);
      if (!hit) {
        process.stderr.write(
          `mbox: no message ${oneLine(id, 140)} to this session in the last ${opts.since} (try --since 180d)\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(formatBlock(hit));
    }),
  );

// ---------------------------------------------------------------- setup
program
  .command('setup')
  .description('write the client config (~/.config/agent-mailbox/config.json, mode 0600)')
  .requiredOption('--servers <urls>', 'mailbox server URL(s), comma-separated')
  .requiredOption('--user <name>', 'your mailbox user name ([a-z0-9-]+)')
  .option(
    '--password-stdin',
    'read the password from stdin (the only way to pass it; never on the command line)',
  )
  .action(
    action(async (opts: { servers: string; user: string; passwordStdin?: boolean }) => {
      const servers = splitServers(opts.servers);
      if (!servers.length) throw new UsageError('--servers is empty');
      for (const s of servers) {
        try {
          validateServer(s);
        } catch (e) {
          throw new UsageError(`--servers: ${errMessage(e)}`);
        }
      }
      if (!/^[a-z0-9-]+$/.test(opts.user)) throw new UsageError('--user must match [a-z0-9-]+');
      if (!opts.passwordStdin)
        throw new UsageError(
          'pass --password-stdin and pipe the password in, e.g.  printf \'%s\\n\' "$PW" | mbox setup ... --password-stdin',
        );
      const password = (await readStdin(process.stdin.isTTY ? 0 : 3000)).split(/\r?\n/)[0];
      if (!password) throw new UsageError('no password arrived on stdin');
      const p = writeConfig({ servers, user: opts.user, password });
      console.log(`wrote ${p} (mode 0600). Verify with: mbox doctor`);
    }),
  );

// ---------------------------------------------------------------- doctor
program
  .command('doctor')
  .description('check configuration, connectivity, auth and permissions')
  .action(async () => {
    let cfg: Config;
    let transport: Transport;
    try {
      cfg = loadConfig();
      transport = openTransport(cfg);
      console.log(
        `ok    config present (${configPath()}; servers ${cfg.servers.join(',')}, user ${cfg.user})`,
      );
    } catch (e) {
      console.log(`FAIL  config\n      -> ${errMessage(e)}`);
      process.exit(1);
    }
    let bad = 0;
    for (const c of await transport.diagnose({ user: cfg.user, host: shortHost() })) {
      if (!c.ok) bad++;
      console.log(
        `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${!c.ok && c.hint ? `\n      -> ${c.hint}` : ''}`,
      );
    }
    console.log(bad ? `\n${bad} problem(s) found` : '\nall checks passed');
    await closeTransports();
    process.exit(bad ? 1 : 0);
  });

// ---------------------------------------------------------------- hook
program
  .command('hook')
  .description(
    'agent hook entry point: mbox hook <agent> <event>  (e.g. mbox hook claude-code session-start)',
  )
  .argument('<agent>', 'adapter id')
  .argument('<event>', 'hook event name')
  .action(async (agentId: string, event: string) => {
    // A hook must never break the host agent: always exit 0.
    try {
      const adapter = getAdapter(agentId);
      const handler = adapter?.hooks?.[event];
      if (!adapter || !handler) {
        process.stderr.write(`mbox hook: no handler for ${agentId} ${event}\n`);
        process.exit(0);
      }
      let input: unknown = {};
      if (!process.stdin.isTTY) {
        try {
          input = JSON.parse((await readStdin(1500)) || '{}') as unknown;
        } catch {
          input = {};
        }
      }
      let cfg: Config | null = null;
      let transport: Transport | null = null;
      let configError: string | null = null;
      try {
        cfg = loadConfig();
        transport = openTransport(cfg);
      } catch (e) {
        configError = errMessage(e);
      }
      // Handlers return before using these when configError is set.
      const configured = (): { cfg: Config; transport: Transport } => {
        if (!cfg || !transport) throw new Error(configError ?? 'the mailbox is not configured');
        return { cfg, transport };
      };
      const ctx: HookContext = {
        env: process.env,
        sessionOverride: globalOpts().session || process.env.AGENT_MAILBOX_SESSION || null,
        launcher: launcherPath(),
        configError,
        ensure: (sid, cwd) =>
          ensureSession({ sid, ...configured(), cwd, hostPid: adapter.hostPid(process.env) }),
        endSession: (sid) => endSession({ sid, ...configured(), agent: adapter.id }),
        register: (reg) => register(reg),
        deregister: (sid) => deregister(sid),
        startDeliverd,
      };
      const out = await handler(input, ctx);
      if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    } catch (e) {
      process.stderr.write(`mbox hook: ${errMessage(e)}\n`);
    }
    await closeTransports();
    await flushStdio();
    process.exit(0);
  });

program.configureOutput({ outputError: (s, write) => write(s) });
await program.parseAsync(process.argv).catch(fail);
