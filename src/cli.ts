import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { adapters, getAdapter, resolveAgent, resolveSession } from './agents/index.js';
import type { HookContext, HookInput, ResolvedSession } from './agents/index.js';
import { BROADCAST, fitLabel, isAddr, parseAddr, shortHost } from './core/addr.js';
import { AREA_MAX, MAX_OFFERS, areaAddress, normalizeArea } from './core/areas.js';
import {
  ConfigError,
  PROFILE_RE,
  configPath,
  loadConfig,
  profileName,
  splitServers,
  writeConfig,
} from './core/config.js';
import { buildEnvelope, formatBlock, oneLine, parseDelivery } from './core/envelope.js';
import { emitEvent, emitStarted } from './core/events.js';
import { fileLog, runDeliverd } from './core/deliverd.js';
import { GUIDE_SECTIONS, guideText } from './core/guide.js';
import { pause, readPause, resume } from './core/pause.js';
import {
  deliverdInfo,
  deliverdLogPath,
  deliverdPid,
  deregister,
  ensureDeliverd,
  listRegistrations,
  readdressRegistration,
  register,
  versionName,
} from './core/registrations.js';
import { ResolveError, peerTree, presenceRecord, resolveTarget } from './core/registry.js';
import {
  MAX_SERVICES,
  SERVICE_NAME_MAX,
  checkServiceName,
  claimBarrier,
  claimService,
  holderLive,
  parseService,
  releaseClaim,
  serviceAddress,
} from './core/services.js';
import {
  ROLES,
  STATUS_MAX,
  TITLE_MAX,
  checkParent,
  checkRole,
  checkTitle,
  statusLength,
  statusLine,
} from './core/session-meta.js';
import { appendSentLog, sentRecord } from './core/sentlog.js';
import { SINCE_RE, SNAPSHOT_SINCE, gatherSnapshot } from './core/snapshot.js';
import { probeUiSocket } from './core/uiserver.js';
import {
  ForeignAddressError,
  NoSessionError,
  addressUser,
  ensureSession,
  pidAlive,
  readState,
  stateDir,
  updateState,
} from './core/state.js';
import { createTransport, explainError, validateServer } from './core/transport/nats.js'; // composition root: the only place that picks the broker
import type {
  Config,
  Envelope,
  EventKind,
  FeedEntry,
  PresenceEntry,
  ServiceClaim,
  SessionState,
  Transport,
  TransportOptions,
} from './core/types.js';
import type { PauseState } from './core/pause.js';
import { compareVersions, ownVersion } from './core/version.js';
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
const bundlePath = fileURLToPath(import.meta.url);
const deliverdArgv = (): string[] => [process.execPath, bundlePath, 'deliverd'];
const sessionEnvVars = (): string[] => [
  'AGENT_MAILBOX_SESSION',
  ...adapters.flatMap((a) => a.delivery?.sessionEnv || []),
];
/** Start the daemon unless one of this version or a newer one runs; an older one hands over. */
const startDeliverd = (): number | null =>
  ensureDeliverd(deliverdArgv(), process.env, {
    dropEnv: sessionEnvVars(),
    version: ownVersion(),
    user: configuredUser(),
    log: fileLog(deliverdLogPath()),
  });
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
  const env = process.env;
  const faults = {
    loseHandBack: Number(env.AGENT_MAILBOX_TEST_LOSE_HANDBACK) || 0,
    handBackDelayMs: Number(env.AGENT_MAILBOX_TEST_HANDBACK_DELAY_MS) || 0,
    startDelayMs: Number(env.AGENT_MAILBOX_TEST_START_DELAY_MS) || 0,
  };
  const t = createTransport(cfg, { ...opts, faults }); // faults: test-only, all zero otherwise
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
    e instanceof ResolveError ||
    e instanceof ForeignAddressError
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
  profile?: string;
}

const program = new Command();
const globalOpts = (): GlobalOptions => program.opts<GlobalOptions>();
program
  .name('mbox')
  .description('Agent mailbox: messages between agent sessions (broker-backed)')
  .version(ownVersion(), '-V, --version', 'print the version')
  .option(
    '--session <id>',
    'agent session id (default: $AGENT_MAILBOX_SESSION, then the detected agent adapter)',
  )
  .option(
    '--agent <id>',
    'agent adapter id (default: $AGENT_MAILBOX_AGENT, then auto-detected, else "unknown")',
  )
  .option(
    '--profile <name>',
    'mailbox profile: whose identity to use (default: $AGENT_MAILBOX_PROFILE, else "default")',
  )
  // --profile works by setting AGENT_MAILBOX_PROFILE, so everything that reads the environment,
  // and the delivery daemon a command starts, uses the same profile.
  .hook('preAction', () => {
    const { profile } = globalOpts();
    if (profile === undefined) return;
    if (profile !== 'default' && !PROFILE_RE.test(profile))
      throw new UsageError(
        `invalid profile "${profile.slice(0, 40)}" (allowed: a-z 0-9 -, starting with a letter or digit, at most 32 characters)`,
      );
    process.env.AGENT_MAILBOX_PROFILE = profile;
  });

/** " (profile <name>)" when a named profile is selected, else "". */
const profileNote = (): string => {
  const p = profileName();
  return p ? ` (profile ${p})` : '';
};

/** Tell the user, on stderr, that the session was given a new address (ensureSession). */
const noteReaddress = (from: string, to: string): void => {
  process.stderr.write(
    `mbox: this session's address was ${from}, which belongs to another user than this mailbox is configured as (${addressUser(to)}); it is now ${to}. Mail to the old address no longer reaches this session.\n`,
  );
};

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
  const st = await ensureSession({
    sid,
    cfg,
    transport,
    cwd: process.cwd(),
    hostPid,
    onReaddress(from, to) {
      noteReaddress(from, to);
      readdressRegistration(sid, to);
    },
  });
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
/** Write the session's state and refresh its live presence entry (if it has one) to match. */
async function saveAndAnnounce(
  { cfg, transport, sid, agent }: SessionContext,
  fn: (s: SessionState) => SessionState,
): Promise<SessionState> {
  const next = updateState(sid, fn);
  await transport.presence
    .update(presenceRecord(next, { sid, cfg, agent }))
    .catch((e) =>
      process.stderr.write(`warning: could not update presence (${explainError(e)})\n`),
    );
  return next;
}

/** Write `event` about the session to the user's feed; a failure is a warning, never an error. */
async function recordEvent(
  { cfg, transport }: SessionContext,
  event: EventKind,
  st: SessionState,
): Promise<void> {
  const err = await emitEvent(transport, event, st, { cfg });
  if (err)
    process.stderr.write(
      `warning: could not write the "${event}" event to your events feed (${explainError(err)})\n`,
    );
}

program
  .command('whoami')
  .description(
    "print this session's mailbox address (and aliases, role, parent, title, status, offers, services); --role/--parent set them",
  )
  .option('--role <role>', `this session's role: ${ROLES.join(', ')} or none (display only)`)
  .option('--parent <address>', 'the address of the session that spawned this one, or none')
  .action(
    action(async (opts: { role?: string; parent?: string }) => {
      const ctx = await context();
      let { st } = ctx;
      if (opts.role !== undefined || opts.parent !== undefined) {
        const role = opts.role === 'none' ? null : checkRole(opts.role);
        if (opts.role !== undefined && opts.role !== 'none' && !role)
          throw new UsageError(`invalid role "${opts.role}" (allowed: ${ROLES.join(', ')}, none)`);
        const parent = opts.parent === 'none' ? null : checkParent(opts.parent);
        if (parent && (parent === st.address || st.aliases.includes(parent)))
          throw new UsageError(`a session cannot be its own parent (${parent})`);
        if (opts.parent !== undefined && opts.parent !== 'none' && !parent)
          throw new UsageError(
            `invalid parent "${opts.parent}" (a full address <user>.<host>.<label>, or none)`,
          );
        const before = st;
        st = await saveAndAnnounce(ctx, (s) => ({
          ...s,
          ...(opts.role !== undefined && { role }),
          ...(opts.parent !== undefined && { parent }),
        }));
        if ((before.role ?? null) !== (st.role ?? null)) await recordEvent(ctx, 'role-changed', st);
        if ((before.parent ?? null) !== (st.parent ?? null))
          await recordEvent(ctx, 'parent-changed', st);
      }
      console.log(st.address);
      const profile = profileName();
      if (profile) console.log(`profile: ${profile}`);
      if (st.aliases.length) console.log(`aliases: ${st.aliases.join(', ')}`);
      if (st.role) console.log(`role: ${st.role}`);
      if (st.parent) console.log(`parent: ${st.parent}`);
      if (st.title) console.log(`title: ${st.title}`);
      if (st.status) console.log(`status: ${st.status}`);
      if (st.offers?.length) console.log(`offers: ${st.offers.join(', ')}`);
      if (st.services?.length) console.log(`services: ${st.services.join(', ')}`);
    }),
  );

// ---------------------------------------------------------------- status
program
  .command('status')
  .description(
    `set this session's one-line status (max ${STATUS_MAX} characters) shown in mbox peers`,
  )
  .argument('[text]', 'the new status; omitted prints the current one')
  .option('--clear', 'remove the status')
  .action(
    action(async (text: string | undefined, opts: { clear?: boolean }) => {
      const ctx = await context();
      if (opts.clear && text !== undefined)
        throw new UsageError('pass either a status or --clear, not both');
      if (!opts.clear && text === undefined) {
        console.log(ctx.st.status ?? '(no status)');
        return;
      }
      const status = opts.clear ? null : checkedStatus(text);
      const next = await saveAndAnnounce(ctx, (s) => ({ ...s, status }));
      if ((ctx.st.status ?? null) !== (next.status ?? null))
        await recordEvent(ctx, 'status-changed', next);
      console.log(next.status ?? '(no status)');
    }),
  );

/** A status line from the command line, or a usage error saying what is wrong with it. */
function checkedStatus(text: string | undefined, what = 'status', max = STATUS_MAX): string {
  const status = statusLine(text);
  if (!status) throw new UsageError(`empty ${what}: use --clear to remove it`);
  if (statusLength(status) > max)
    throw new UsageError(
      `${what} is ${statusLength(status)} characters; the limit is ${max}. Shorten it.`,
    );
  return status;
}

// ---------------------------------------------------------------- title
program
  .command('title')
  .description(
    `set this session's title (one line, max ${TITLE_MAX} characters) shown in mbox peers; the session-start hook sets it from the agent's own session title`,
  )
  .argument('[text]', 'the new title; omitted prints the current one')
  .option('--clear', 'remove the title')
  .action(
    action(async (text: string | undefined, opts: { clear?: boolean }) => {
      const ctx = await context();
      if (opts.clear && text !== undefined)
        throw new UsageError('pass either a title or --clear, not both');
      if (!opts.clear && text === undefined) {
        console.log(ctx.st.title ?? '(no title)');
        return;
      }
      const title = opts.clear ? null : checkedStatus(text, 'title', TITLE_MAX);
      const next = await saveAndAnnounce(ctx, (s) => ({ ...s, title }));
      console.log(next.title ?? '(no title)');
    }),
  );

// ---------------------------------------------------------------- done
program
  .command('done')
  .description(
    `say this session has finished: sets its status to <summary> (max ${STATUS_MAX} characters) and writes a "done" event to your events feed`,
  )
  .argument('<summary>', 'one line: what was done (no secrets: colleagues may read your feed)')
  .action(
    action(async (summary: string) => {
      const ctx = await context();
      const status = checkedStatus(summary);
      const next = await saveAndAnnounce(ctx, (s) => ({ ...s, status }));
      await recordEvent(ctx, 'done', next);
      console.log(next.status ?? '(no status)');
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
      // Bounded: a waiter that stepped aside must exit before the one it yielded to gives up on it.
      await Promise.race([closeTransports(), new Promise((r) => setTimeout(r, 2000).unref())]);
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
  .option(
    '--status',
    'print whether it runs (its version and bundle) and which sessions are registered, then exit',
  )
  .action(async (opts: { status?: boolean }) => {
    if (opts.status) {
      const d = deliverdInfo();
      const mine = ownVersion();
      if (!d) console.log('deliverd not running');
      else {
        console.log(`deliverd running (pid ${d.pid}, version ${versionName(d.version)})`);
        if (d.user) console.log(`user: ${d.user}${profileNote()}`);
        if (d.exe)
          console.log(
            `executable: ${oneLine(d.exe, 300)}${fs.existsSync(d.exe) ? '' : ' (no longer exists; it runs from memory)'}`,
          );
        const cmp = compareVersions(mine, d.version);
        if (cmp > 0)
          console.log(`this mbox is ${mine}: the next session start hands delivery over to it`);
        else if (cmp < 0) console.log(`this mbox is ${mine} (older): it leaves the daemon alone`);
      }
      const regs = listRegistrations();
      if (!regs.length) console.log('no registered sessions');
      const servedAs = d?.user ?? configuredUser();
      for (const r of regs) {
        const host = r.hostPid
          ? `pid ${r.hostPid}${pidAlive(r.hostPid) ? '' : ' (gone)'}`
          : 'pid ?';
        const address = readState(r.sid)?.address ?? r.address;
        const owner = addressUser(address);
        const foreign =
          servedAs && owner !== servedAs
            ? `  (user ${owner ?? '?'}, not ${servedAs}: not served)`
            : '';
        console.log(
          `${oneLine(address, 140)}  ${oneLine(r.agent, 30)}  ${oneLine(r.endpoint.kind, 40)}  ${host}${foreign}`,
        );
      }
      const p = readPause();
      if (p.all || p.addresses.length)
        console.log(`paused: ${pauseSummary(p)} (mbox resume to continue)`);
      const ui = d ? await probeUiSocket() : null;
      if (ui) console.log(`snapshots: ${ui} (GET /v1/snapshot?session=<id>)`);
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
      version: ownVersion(),
      exe: bundlePath,
      log,
      restart() {
        // After a plugin update this bundle may be gone: a spawn of it would only crash.
        if (!fs.existsSync(bundlePath)) throw new Error(`${bundlePath} no longer exists`);
        startDeliverd();
      },
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
  p.all
    ? `all sessions on this machine${profileNote()}`
    : p.addresses.length
      ? p.addresses.join(', ')
      : 'nothing';

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
        `delivery paused for ${opts.all ? `all sessions on this machine${profileNote()}` : target}; mail waits on the server. Paused now: ${pauseSummary(p)}. Undo with: mbox resume${opts.all ? '' : ` ${target}`}`,
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

/**
 * Does a live session hold `service`? A claim whose holder has no presence entry does not count.
 * null when it cannot be told (no registry, or the claim unreadable): the message is queued anyway.
 */
async function serviceLive(
  transport: Transport,
  service: string,
  peers: PresenceEntry[],
  registryErr: unknown,
): Promise<boolean | null> {
  if (registryErr) return null;
  try {
    const { claim } = await transport.services.read(service);
    return !!claim && holderLive(claim, peers);
  } catch {
    return null;
  }
}

/** Add a sent message to the session's sent log; a failure is a warning (the message is sent). */
function recordSent(sid: string, envelope: Envelope): void {
  try {
    appendSentLog(
      sid,
      sentRecord({
        id: envelope.id,
        to: envelope.to,
        subject: envelope.subject,
        body: envelope.body,
        inReplyTo: envelope.inReplyTo,
      }),
    );
  } catch (e) {
    process.stderr.write(
      `warning: could not add the message to this session's sent log (${errMessage(e)})\n`,
    );
  }
}

program
  .command('send')
  .description(
    'send a message to a session address, a service address (<user>.<name>), a unique prefix/label of a live peer, or "all"',
  )
  .argument(
    '<to>',
    'full address, service address <user>.<name>, unique prefix/label of a live peer, or "all"',
  )
  .argument('[text]', 'message text; "-" or omitted reads stdin')
  .option('--subject <s>', 'subject line')
  .option('--re <id>', 'id of the message this replies to')
  .action(
    action(
      async (to: string, text: string | undefined, opts: { subject?: string; re?: string }) => {
        const { cfg, transport, sid, st, agent } = await context();
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
        const service = parseService(to);
        // Whether a live session holds the service: null when that cannot be told.
        const serviceHeld = service ? await serviceLive(transport, to, peers, registryErr) : null;
        const serviceKnown = serviceHeld !== null;
        if (service) target = { to, live: serviceHeld === true };
        else if (to === BROADCAST || (isAddr(to) && registryErr)) target = { to, live: true };
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
        recordSent(sid, envelope);
        if (service && !serviceKnown) {
          process.stderr.write(
            `warning: could not check whether a live session holds ${to}; the message is stored on the server either way.\n`,
          );
        } else if (service && !target.live) {
          // Before 0.7.0 a two-part target was a prefix of session addresses: say so when it is one.
          const prefixOf = peers.filter((p) => p.live && p.address.startsWith(`${to}.`));
          process.stderr.write(
            `warning: no live session holds ${to}; the message is queued on the server (kept for the server's retention period, 180 days by default) until a session claims it with mbox name --service ${service.name}.${prefixOf.length ? ` (${to} is a service address; to reach live session ${prefixOf.map((p) => p.address).join(', ')}, use the full address.)` : ''}\n`,
          );
        } else if (!target.live) {
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
  .option('--tree', 'show which session spawned which (by their self-asserted parent)')
  .action(
    action(async (opts: { tree?: boolean }) => {
      const { transport } = await context({ needSession: false });
      const peers = (await transport.presence.list()).filter((p) => p.live);
      if (!peers.length) {
        console.log('no live peers');
        return;
      }
      // Who holds which service: the claims name the holding session.
      const claims = await transport.services.list().catch((): ServiceClaim[] => []);
      const servicesOf = (p: PresenceEntry): string[] =>
        claims
          .filter((c) => c.session === p.session && parseService(c.service)?.user === p.user)
          .map((c) => c.service);
      const lines = opts.tree
        ? peerTree(peers).map(({ peer, prefix, note }) => ({
            peer,
            address:
              prefix +
              oneLine(peer.address, 80) +
              (note ? ` (${note}: ${oneLine(peer.parent, 80)})` : ''),
          }))
        : peers.map((peer) => ({ peer, address: oneLine(peer.address, 80) }));
      const rows: string[][] = [
        [
          'ADDRESS',
          'ALIASES',
          'AGENT',
          'USER@HOST',
          'TITLE',
          'ROLE',
          'REPO',
          'BRANCH',
          'STATUS',
          'OFFERS',
          'SERVICES',
          'CWD',
          'LAST SEEN',
        ],
      ];
      for (const { peer: p, address } of lines) {
        rows.push([
          address,
          p.aliases.length ? p.aliases.map((a) => oneLine(a, 60)).join(',') : '-',
          oneLine(p.agent ?? '-', 30),
          `${oneLine(p.user ?? '?', 30)}@${oneLine(p.host ?? '?', 30)}`,
          oneLine(p.title ?? '-', 60),
          p.role ?? '-',
          p.repo ?? '-',
          oneLine(p.branch ?? '-', 40),
          oneLine(p.status ?? '-', 60),
          p.offers.length ? oneLine(p.offers.join(','), 80) : '-',
          servicesOf(p).length ? oneLine(servicesOf(p).join(','), 80) : '-',
          oneLine(p.cwd ?? '-', 60),
          ago(p.lastSeen),
        ]);
      }
      printTable(rows);
    }),
  );

/** Print rows as aligned columns; every row has as many cells as the first (the header). */
function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...r[i]!].length)));
  for (const r of rows)
    console.log(
      r
        .map((c, i) => c + ' '.repeat(widths[i]! - [...c].length))
        .join('  ')
        .trimEnd(),
    );
}

// ---------------------------------------------------------------- name
interface NameOptions {
  service?: string;
  release?: boolean;
  takeover?: boolean;
}

program
  .command('name')
  .description(
    'add an alias address (<user>.<host>.<label>) for this session, or claim a service address (<user>.<name>) with --service',
  )
  .argument('[label]', 'new alias label, [a-z0-9-]+')
  .option(
    '--service <name>',
    'claim the service address <user>.<name>: its mail, queued while nobody held it, comes to this session',
  )
  .option(
    '--release',
    'with --service: release it (its mail queues again until a session claims it)',
  )
  .option('--takeover', 'with --service: take it over even from a live session that holds it')
  .action(
    action(async (label: string | undefined, opts: NameOptions) => {
      if (opts.service !== undefined) {
        if (label !== undefined)
          throw new UsageError('give either a label or --service <name>, not both');
        await nameService(opts.service, opts);
        return;
      }
      if (opts.release || opts.takeover)
        throw new UsageError('--release and --takeover go with --service <name>');
      if (label === undefined)
        throw new UsageError('missing label (or --service <name> to claim a service address)');
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

/** `mbox name --service <name> [--release | --takeover]`. */
async function nameService(name: string, opts: NameOptions): Promise<void> {
  if (opts.release && opts.takeover)
    throw new UsageError('--release and --takeover cannot be used together');
  if (!checkServiceName(name))
    throw new UsageError(
      `invalid service name "${oneLine(name, 60)}" (allowed: a-z 0-9 -, at most ${SERVICE_NAME_MAX} characters)`,
    );
  const { transport, sid, st } = await context();
  const me = parseAddr(st.address)!; // a session's address is a valid one: ensureSession built it
  const service = serviceAddress(me.user, name);
  const holder = { service, holder: st.address, session: sid };
  const held = (st.services ?? []).includes(service);

  if (opts.release) {
    // The state first: the receiver stops reading the service, and the subscription would not read
    // it without the claim anyway.
    if (held)
      updateState(sid, (s) => ({
        ...s,
        services: (s.services ?? []).filter((x) => x !== service),
      }));
    if (await releaseClaim(transport.services, holder)) console.log(service);
    else if (held)
      process.stderr.write(`mbox: this session no longer held ${service}; removed it here\n`);
    else {
      process.stderr.write(`mbox: this session does not hold ${service}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!held && (st.services ?? []).length >= MAX_SERVICES)
    throw new UsageError(
      `this session already holds ${MAX_SERVICES} service addresses, the most it may; release one first`,
    );
  // Liveness of a current holder: its presence entry. Without the registry, every holder counts as
  // live, so nothing is taken from a live session by mistake.
  let peers: PresenceEntry[] | null = null;
  try {
    peers = await transport.presence.list();
  } catch (e) {
    process.stderr.write(`warning: could not read the peer registry (${explainError(e)})\n`);
  }
  const barrier = process.env.AGENT_MAILBOX_TEST_CLAIM_BARRIER; // test-only fault injection
  const res = await claimService(transport.services, holder, {
    takeover: opts.takeover,
    isLive: (c) => (peers ? holderLive(c, peers) : true),
    ...(barrier && { beforeWrite: claimBarrier(barrier, sid) }),
  });
  if (res.status === 'taken') {
    process.stderr.write(
      `mbox: ${service} is held by live session ${res.by.holder}; mail to it goes there. Pass --takeover to take it over.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!held)
    updateState(sid, (s) => ({
      ...s,
      services: [...new Set([...(s.services ?? []), service])].sort(),
    }));
  if (res.status === 'claimed' && res.replaced) {
    const was = res.replaced;
    const live = peers ? holderLive(was, peers) : true;
    process.stderr.write(
      `took ${service} over from ${live ? 'live' : 'no longer live'} session ${was.holder}${live ? ', which stops receiving its mail' : ''}\n`,
    );
  }
  // An older delivery daemon does not read services: let one of this version take over.
  if (listRegistrations().some((r) => r.sid === sid)) startDeliverd();
  if (peers && !peers.some((p) => p.live && p.session === sid))
    process.stderr.write(
      `warning: this session has no live receiver (no presence entry), so ${service}'s mail waits until one runs (the delivery daemon, mbox wait or mbox watch), and another session may claim ${service} meanwhile\n`,
    );
  console.log(service);
}

// ---------------------------------------------------------------- services
program
  .command('services')
  .description('list the claimed service addresses and the sessions holding them')
  .action(
    action(async () => {
      const { transport } = await context({ needSession: false });
      const [claims, peers] = await Promise.all([
        transport.services.list(),
        transport.presence.list(),
      ]);
      if (!claims.length) {
        console.log('no claimed services');
        return;
      }
      const rows: string[][] = [['SERVICE', 'HOLDER', 'LIVE', 'REFRESHED']];
      for (const c of claims)
        rows.push([
          oneLine(c.service, 80),
          oneLine(c.holder, 80),
          holderLive(c, peers) ? 'yes' : 'no',
          ago(c.lastSeen),
        ]);
      printTable(rows);
    }),
  );

// ---------------------------------------------------------------- offer / unoffer / ask
/** An area from the command line, or a usage error saying what is wrong with it. */
function checkedArea(input: string): string {
  const area = normalizeArea(input);
  if (!area)
    throw new UsageError(
      `invalid area "${oneLine(input, 60)}" (lower case a-z 0-9 and . _ : / @ + -, starting with a letter or digit, at most ${AREA_MAX} characters; e.g. repo:github.com/acme/web)`,
    );
  return area;
}

/** Warn when the server has no asks yet: offering or asking would do nothing there. */
async function warnWithoutAsks(transport: Transport): Promise<void> {
  const ok = await transport.asksReadable().catch(() => true); // unreachable: other commands say so
  if (!ok)
    process.stderr.write(
      'warning: the server has no stream for asks yet (it was set up before help areas); ask the admin to run mbox-admin.sh init\n',
    );
}

program
  .command('offer')
  .description(
    'offer help in an area (e.g. repo:github.com/acme/web): asks there reach this session, including the ones still kept (7 days by default); without an area, list your offers',
  )
  .argument('[area]', 'the area: lower case a-z 0-9 . _ : / @ + -')
  .action(
    action(async (input: string | undefined) => {
      const ctx = await context();
      if (input === undefined) {
        const offers = ctx.st.offers ?? [];
        console.log(offers.length ? offers.join('\n') : '(no offers)');
        return;
      }
      const area = checkedArea(input);
      const have = ctx.st.offers ?? [];
      if (!have.includes(area) && have.length >= MAX_OFFERS)
        throw new UsageError(
          `this session already offers ${MAX_OFFERS} areas, the most it may; mbox unoffer one first`,
        );
      await saveAndAnnounce(ctx, (s) => ({
        ...s,
        offers: [...new Set([...(s.offers ?? []), area])].sort(),
      }));
      await warnWithoutAsks(ctx.transport);
      console.log(area);
    }),
  );

program
  .command('unoffer')
  .description('stop offering help in an area')
  .argument('<area>', 'the area, as mbox offer lists it')
  .action(
    action(async (input: string) => {
      const ctx = await context();
      const area = checkedArea(input);
      if (!(ctx.st.offers ?? []).includes(area)) {
        process.stderr.write(`mbox: this session does not offer ${area}\n`);
        process.exitCode = 1;
        return;
      }
      await saveAndAnnounce(ctx, (s) => ({
        ...s,
        offers: (s.offers ?? []).filter((a) => a !== area),
      }));
      console.log(area);
    }),
  );

const QUEUED =
  "the ask stays queued for sessions that offer the area later (the server's retention for asks, 7 days by default). Replies come to you as mail.";

program
  .command('ask')
  .description(
    'ask for help in an area: delivered to every live session offering it, and kept (7 days by default) for sessions that offer it later; helpers reply to you directly',
  )
  .argument('<area>', 'the area, e.g. repo:github.com/acme/web')
  .argument('[question]', 'the question; "-" or omitted reads stdin')
  .option('--subject <s>', 'subject line')
  .action(
    action(async (input: string, text: string | undefined, opts: { subject?: string }) => {
      const area = checkedArea(input);
      const { cfg, transport, sid, st, agent } = await context();
      let body = text;
      if (body === '-' || (body === undefined && !process.stdin.isTTY))
        body = await readStdin(body === undefined ? 3000 : 0);
      if (body === undefined || body === '')
        throw new UsageError('empty question: pass text as an argument or on stdin');
      const envelope = buildEnvelope({
        from: st.address,
        to: areaAddress(area),
        agent,
        subject: opts.subject,
        body,
      });
      const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
      if (cfg.maxBytes && size > cfg.maxBytes)
        throw new UsageError(
          `question is ${size} bytes as an envelope but your configured limit (AGENT_MAILBOX_MAX_BYTES / "maxMessageBytes") is ${cfg.maxBytes}. Shorten it or raise the limit.`,
        );
      const res = await transport.publish(areaAddress(area), envelope);
      recordSent(sid, envelope);
      try {
        const helpers = (await transport.presence.list()).filter(
          (p) => p.live && p.offers.includes(area) && p.session !== sid,
        );
        process.stderr.write(
          helpers.length
            ? `asked ${helpers.length} live session${helpers.length === 1 ? '' : 's'} offering ${area} (${helpers.map((p) => p.address).join(', ')}); ${QUEUED}\n`
            : `no live session offers ${area} right now; ${QUEUED}\n`,
        );
      } catch {
        /* the count is a courtesy */
      }
      console.log(res.id);
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
    'print recent messages (your addresses, the services you hold, broadcasts and asks in the areas you offer) without moving the watcher cursor',
  )
  .option('--since <dur>', 'how far back (e.g. 30m, 2h, 1d)', '2h')
  .action(
    action(async (opts: { since: string }) => {
      if (!/^\d+[smhd]$/.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 1d (got "${opts.since}")`);
      const { cfg, transport, st } = await context();
      const names = [st.address, ...st.aliases];
      const areas = (st.offers ?? []).map(areaAddress);
      const deliveries = await transport.poll(
        [...names, ...(st.services ?? []), BROADCAST, ...areas],
        {
          lookbackMs: sinceMs(opts.since),
        },
      );
      let n = 0;
      for (const d of deliveries) {
        const m = parseDelivery(d);
        const shared = d.to === BROADCAST || areas.includes(d.to); // own broadcasts and asks: skipped
        if (shared && m.sender === cfg.user && names.includes(m.from)) continue;
        process.stdout.write(formatBlock(m));
        n++;
      }
      if (!n) console.log(`no messages in the last ${opts.since}`);
    }),
  );

// ---------------------------------------------------------------- snapshot
program
  .command('snapshot')
  .description(
    'print this session, live peers, recent mail, sent messages, threads and help areas as one JSON object (for a side panel)',
  )
  .option('--json', 'JSON output (required: the only format)')
  .option(
    '--since <dur>',
    'how far back for mail and sent messages (e.g. 30m, 2h, 1d)',
    SNAPSHOT_SINCE,
  )
  .action(
    action(async (opts: { json?: boolean; since: string }) => {
      if (!opts.json) throw new UsageError('pass --json (the only output format)');
      if (!SINCE_RE.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 1d (got "${opts.since}")`);
      const { cfg, transport, sid, st } = await context();
      // The daemon's snapshot socket, when it serves this session: later polls need no process.
      const registered = listRegistrations().some((r) => r.sid === sid);
      const [snap, socket] = await Promise.all([
        gatherSnapshot({
          transport,
          user: cfg.user,
          sid,
          state: st,
          since: opts.since,
          sinceMs: sinceMs(opts.since),
          socket: null,
        }),
        registered ? probeUiSocket() : Promise.resolve(null),
      ]);
      snap.socket = socket;
      process.stdout.write(JSON.stringify(snap) + '\n');
    }),
  );

// ---------------------------------------------------------------- events
interface EventsOptions {
  user?: string;
  all?: boolean;
  since: string;
  limit: string;
  json?: boolean;
  sharing?: boolean;
}

/** How many events `mbox events` reads from one feed at most. */
const FEED_READ_MAX = 10000;

program
  .command('events')
  .description(
    "print the events feed (sessions started, ended, status/role/parent changes, done): yours, a colleague's (--user) or every one you may read (--all)",
  )
  .option(
    '--user <name>',
    "a colleague's feed (readable only when the admin shares it with the team)",
  )
  .option('--all', 'your feed and every feed shared with the team')
  .option('--since <dur>', 'how far back (e.g. 30m, 2h, 1d; feeds keep 30 days)', '1d')
  .option('--limit <n>', 'print at most the newest <n> events', '100')
  .option('--json', 'one JSON object per line instead of a table')
  .option('--sharing', 'print how your feed is shared, and which feeds are shared with the team')
  .action(
    action(async (opts: EventsOptions) => {
      if (opts.user !== undefined && opts.all)
        throw new UsageError('pass either --user or --all, not both');
      if (opts.user !== undefined && !/^[a-z0-9-]+$/.test(opts.user))
        throw new UsageError(`--user must be a mailbox user name, [a-z0-9-]+ (got "${opts.user}")`);
      if (!/^\d+[smhd]$/.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 1d (got "${opts.since}")`);
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1)
        throw new UsageError(`--limit must be a positive whole number (got "${opts.limit}")`);
      const { cfg, transport } = await context({ needSession: false });

      if (opts.sharing) {
        const team = await transport.events.shared();
        if (team === null) {
          console.log(
            'sharing: unknown (the server has no sharing list; ask the admin to run mbox-admin.sh init)',
          );
          return;
        }
        console.log(
          team.includes(cfg.user)
            ? 'your feed: team (every mailbox user can read it)'
            : 'your feed: private (only you can read it)',
        );
        const others = team.filter((u) => u !== cfg.user).sort();
        console.log(`shared with the team: ${others.length ? others.join(', ') : '(none)'}`);
        return;
      }

      let users = [opts.user ?? cfg.user];
      if (opts.all) {
        const team = await transport.events.shared();
        if (team === null)
          process.stderr.write(
            'warning: the server has no sharing list, so only your own feed is shown (the admin runs mbox-admin.sh init)\n',
          );
        users = [...new Set([cfg.user, ...(team ?? []).sort()])];
      }
      const lookback = sinceMs(opts.since);
      const entries: FeedEntry[] = [];
      for (const u of users) {
        try {
          const got = await transport.events.read(u, { sinceMs: lookback, max: FEED_READ_MAX });
          if (got.length >= FEED_READ_MAX)
            process.stderr.write(
              `warning: ${u}'s feed has more than ${FEED_READ_MAX} events since ${opts.since}; only the oldest ${FEED_READ_MAX} were read (use a shorter --since)\n`,
            );
          entries.push(...got);
        } catch (e) {
          // --all: a feed that stopped being shared since the list was written is skipped.
          if (!opts.all || !(e as { notShared?: boolean } | null)?.notShared) throw e;
          process.stderr.write(`warning: ${explainError(e)}; skipped\n`);
        }
      }
      entries.sort((a, b) => a.time - b.time);
      const shown = entries.slice(-limit);
      if (opts.json) {
        for (const e of shown) console.log(JSON.stringify(e));
        return;
      }
      if (!shown.length) {
        console.log(`no events in the last ${opts.since}`);
        return;
      }
      if (entries.length > shown.length)
        console.log(`(${entries.length - shown.length} older events not shown; --limit)`);
      const rows: string[][] = [
        ['TIME', 'EVENT', 'ADDRESS', 'ROLE', 'REPO', 'BRANCH', 'PARENT', 'STATUS'],
      ];
      for (const e of shown)
        rows.push([
          new Date(e.time).toISOString().replace(/\.\d+Z$/, 'Z'),
          e.event,
          oneLine(e.address, 80),
          e.role ?? '-',
          e.repo ?? '-',
          oneLine(e.branch ?? '-', 40),
          oneLine(e.parent ?? '-', 80),
          oneLine(e.status ?? '-', 60),
        ]);
      printTable(rows);
    }),
  );

// ---------------------------------------------------------------- show
program
  .command('show')
  .description(
    'print one message (to this session, a service it holds, a broadcast or an ask in an area you offer) in full, by its id',
  )
  .argument('<id>', 'message id, as in "[mailbox] message <id>"')
  .option('--since <dur>', 'how far back to look (e.g. 2h, 7d)', '30d')
  .action(
    action(async (id: string, opts: { since: string }) => {
      if (!/^\d+[smhd]$/.test(opts.since))
        throw new UsageError(`--since must look like 30m, 2h or 7d (got "${opts.since}")`);
      const { transport, st } = await context();
      const areas = (st.offers ?? []).map(areaAddress);
      const deliveries = await transport.poll(
        [st.address, ...st.aliases, ...(st.services ?? []), BROADCAST, ...areas],
        { lookbackMs: sinceMs(opts.since), max: Infinity },
      );
      // Ids are chosen by senders, so several messages can share one: show each of them.
      const hits = deliveries.map(parseDelivery).filter((m) => m.id === id);
      if (!hits.length) {
        process.stderr.write(
          `mbox: no message ${oneLine(id, 140)} to this session in the last ${opts.since} (try --since 180d)\n`,
        );
        process.exitCode = 1;
        return;
      }
      for (const hit of hits) process.stdout.write(formatBlock(hit));
    }),
  );

// ---------------------------------------------------------------- setup
program
  .command('setup')
  .description(
    'write the client config (~/.config/agent-mailbox/config.json, or profiles/<name>.json with --profile; mode 0600)',
  )
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
      const profile = profileName();
      console.log(
        `wrote ${p} (mode 0600). Verify with: mbox doctor${profile ? ` --profile ${profile}` : ''}`,
      );
    }),
  );

// ---------------------------------------------------------------- doctor
/** The configured mailbox user, or null when the config is incomplete. */
function configuredUser(): string | null {
  try {
    return loadConfig().user;
  } catch {
    return null;
  }
}

/**
 * Checks of this machine's state for `mbox doctor`: does the delivery daemon run as the configured
 * user, and does every registered session have an address under it?
 */
function localChecks(user: string): Array<{ ok: boolean; name: string; hint?: string }> {
  const out: Array<{ ok: boolean; name: string; hint?: string }> = [];
  const d = deliverdInfo();
  if (d?.user && d.user !== user)
    out.push({
      ok: false,
      name: `delivery daemon runs as user ${d.user} (pid ${d.pid})`,
      hint: `this profile is configured as ${user}. After a change to the config file the daemon restarts itself within 30 s; the next session start with this configuration takes delivery over`,
    });
  const foreign = listRegistrations()
    .map((r) => readState(r.sid)?.address ?? r.address)
    .filter((a) => addressUser(a) !== user);
  if (foreign.length)
    out.push({
      ok: false,
      name: `${foreign.length} registered session(s) under another user: ${foreign.map((a) => oneLine(a, 80)).join(', ')}`,
      hint: `their mail is not delivered (they were registered before the mailbox user changed to ${user}); restart those sessions, or run an mbox command in each, to give them addresses under ${user}`,
    });
  else out.push({ ok: true, name: `registered sessions belong to user ${user} (${stateDir()})` });
  return out;
}

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
        `ok    config present (${configPath()}; servers ${cfg.servers.join(',')}, user ${cfg.user}${profileName() ? `, profile ${profileName()}` : ''})`,
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
    for (const c of localChecks(cfg.user)) {
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
        profile: configError ? null : profileName(), // loadConfig checked the name
        ensure: async (sid, cwd) => {
          let replaced: string | null = null;
          const state = await ensureSession({
            sid,
            ...configured(),
            cwd,
            hostPid: adapter.hostPid(process.env),
            onReaddress: (from) => (replaced = from),
          });
          return { state, replaced };
        },
        endSession: (sid) => endSession({ sid, ...configured(), agent: adapter.id }),
        // The state file only: the session's receiver sees it change and announces it (a
        // presence write here could hold the hook up on a slow server).
        setTitle: (sid, text) => {
          const title = checkTitle(text);
          try {
            if (title) updateState(sid, (s) => ({ ...s, title }));
          } catch {
            /* display only */
          }
        },
        event: async (sid, event) => {
          const st = readState(sid);
          if (!st || !cfg || !transport) return;
          if (event === 'started') await emitStarted(transport, st, { cfg, sid });
          else await emitEvent(transport, event, st, { cfg });
        },
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
