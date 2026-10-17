import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { adapters, getAdapter, resolveAgent, resolveSession } from './agents/index.js';
import { BROADCAST, fitLabel, isAddr, parseAddr, shortHost } from './core/addr.js';
import { ConfigError, configPath, loadConfig, splitServers, writeConfig } from './core/config.js';
import { buildEnvelope, formatBlock, oneLine, parseDelivery } from './core/envelope.js';
import { fileLog, runDeliverd } from './core/deliverd.js';
import { GUIDE_SECTIONS, guideText } from './core/guide.js';
import { pause, readPause, resume } from './core/pause.js';
import { deliverdLogPath, deliverdPid, deregister, ensureDeliverd, listRegistrations, register } from './core/registrations.js';
import { ResolveError, presenceRecord, resolveTarget } from './core/registry.js';
import { NoSessionError, ensureSession, pidAlive, readState, updateState } from './core/state.js';
import { createTransport, explainError, validateServer } from './core/transport/nats.js'; // composition root: the only place that picks the broker
import { MAX_WAIT_MS, endSession, runWait } from './core/wait.js';
import { runWatch } from './core/watch.js';

class UsageError extends Error {}

const here = path.dirname(fileURLToPath(import.meta.url));
function launcherPath() {
  for (const rel of ['../bin/mbox', '../adapters/claude-code/bin/mbox']) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(p)) return p;
  }
  return 'mbox';
}

// The delivery daemon: `node <this bundle> deliverd`, started detached when sessions need it.
const deliverdArgv = () => [process.execPath, fileURLToPath(import.meta.url), 'deliverd'];
const sessionEnvVars = () => ['AGENT_MAILBOX_SESSION', ...adapters.flatMap((a) => a.delivery?.sessionEnv || [])];
const startDeliverd = () => ensureDeliverd(deliverdArgv(), process.env, { dropEnv: sessionEnvVars() });
/** Bring the daemon back if sessions are registered but it is not running (it may have crashed). */
function reviveDeliverd() {
  try {
    if (!deliverdPid() && listRegistrations().length) startDeliverd();
  } catch { /* best effort */ }
}

// Every transport created by a command; closed before the process exits.
const transports = [];
function openTransport(cfg, opts) {
  const t = createTransport(cfg, opts);
  transports.push(t);
  return t;
}
const closeTransports = () => Promise.all(transports.map((t) => t.close().catch(() => {})));

async function fail(e) {
  const msg = e instanceof ConfigError || e instanceof NoSessionError || e instanceof UsageError || e instanceof ResolveError ? e.message : explainError(e);
  process.stderr.write(`mbox: ${msg}\n`);
  await closeTransports();
  process.exit(e instanceof UsageError ? 2 : 1);
}

const program = new Command();
program
  .name('mbox')
  .description('Agent mailbox: messages between agent sessions (broker-backed)')
  .option('--session <id>', 'agent session id (default: $AGENT_MAILBOX_SESSION, then the detected agent adapter)')
  .option('--agent <id>', 'agent adapter id (default: $AGENT_MAILBOX_AGENT, then auto-detected, else "unknown")');

async function context({ needSession = true } = {}) {
  const cfg = loadConfig();
  reviveDeliverd();
  const transport = openTransport(cfg);
  const agent = resolveAgent({ agent: program.opts().agent });
  if (!needSession) return { cfg, transport, agent: agent.id };
  const { sid, hostPid } = resolveSession({ session: program.opts().session, agent });
  const st = await ensureSession({ sid, cfg, transport, cwd: process.cwd(), hostPid });
  return { cfg, transport, sid, st, agent: agent.id, hostPid };
}

const action = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    await fail(e);
  }
  await closeTransports();
  process.exit(process.exitCode ?? 0);
};

// ---------------------------------------------------------------- whoami
program
  .command('whoami')
  .description("print this session's mailbox address")
  .action(action(async () => {
    const { st } = await context();
    console.log(st.address);
    if (st.aliases.length) console.log(`aliases: ${st.aliases.join(', ')}`);
  }));

// ---------------------------------------------------------------- watch
program
  .command('watch')
  .description('stream incoming messages to stdout (for an agent feature that turns a background process\'s output into notifications)')
  .action(async () => {
    let cfg;
    let session;
    const agent = resolveAgent({ agent: program.opts().agent });
    try {
      cfg = loadConfig();
      session = resolveSession({ session: program.opts().session, agent });
    } catch (e) {
      // As a monitor, one clear line then a clean exit beats a stack trace.
      process.stdout.write(`[mailbox] not running: ${e.message}\n`);
      process.exit(0);
    }
    try {
      const code = await runWatch({ cfg, transport: openTransport(cfg), sid: session.sid, agent: agent.id, hostPid: session.hostPid });
      process.exit(code);
    } catch (e) {
      process.stdout.write(`[mailbox] watcher failed: ${explainError(e)}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- wait
/** A hook's stdin JSON, or {}: never blocks on a terminal, gives up on a pipe that stays silent. */
function readHookStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((resolve) => {
    const chunks = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(j && typeof j === 'object' ? j : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

program
  .command('wait')
  .description('wait for mail, print it on stderr as one batch and exit 2; exit 0 when none came (fallback receiver: run it as a background task)')
  .option('--hook-stdin', 'read the agent hook JSON on stdin (session id, cwd)')
  .option('--max-wait <seconds>', 'exit 0 after this long without mail (keep it below the hook timeout)', '540')
  .action(async (opts) => {
    // An agent hook: never a stack trace, never a failing status. 2 means "mail on stderr".
    const quit = (msg) => {
      if (msg) process.stderr.write(`mbox wait: ${msg}\n`);
      process.exit(0);
    };
    const seconds = Number(opts.maxWait);
    if (!Number.isFinite(seconds) || seconds <= 0) quit(`--max-wait must be a positive number of seconds (got "${opts.maxWait}")`);
    const agent = resolveAgent({ agent: program.opts().agent });
    const input = opts.hookStdin ? await readHookStdin(2000) : {};
    const hook = agent.adapter?.hookInput?.(input) || {};
    // Only a hook can stall its host; run directly (e.g. as a background task) it may always wait.
    if (opts.hookStdin && agent.adapter?.canWait && !agent.adapter.canWait(process.env)) quit();
    let cfg;
    let session;
    try {
      cfg = loadConfig();
      session = resolveSession({ session: program.opts().session, agent, hookSession: hook.sessionId });
    } catch (e) {
      quit(e.message);
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
        write: (text) => new Promise((resolve, reject) => process.stderr.write(text, (err) => (err ? reject(err) : resolve()))),
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
  .description('the delivery daemon: pushes mail into registered agent sessions (started automatically by the session-start hook)')
  .option('--status', 'print whether it runs and which sessions are registered, then exit')
  .action(async (opts) => {
    if (opts.status) {
      const pid = deliverdPid();
      console.log(pid ? `deliverd running (pid ${pid})` : 'deliverd not running');
      const regs = listRegistrations();
      if (!regs.length) console.log('no registered sessions');
      for (const r of regs) {
        const host = r.hostPid ? `pid ${r.hostPid}${pidAlive(r.hostPid) ? '' : ' (gone)'}` : 'pid ?';
        console.log(`${oneLine(r.address, 140)}  ${oneLine(r.agent, 30)}  ${oneLine(r.endpoint.kind, 40)}  ${host}`);
      }
      const p = readPause();
      if (p.all || p.addresses.length) console.log(`paused: ${pauseSummary(p)} (mbox resume to continue)`);
      console.log(`log: ${deliverdLogPath()}`);
      process.exit(0);
    }
    const log = fileLog(deliverdLogPath());
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      log(`not starting: ${e.message}`);
      process.exit(0);
    }
    process.on('unhandledRejection', (e) => log(`internal error (continuing): ${explainError(e)}`));
    process.on('uncaughtException', (e) => {
      log(`crashed: ${e?.stack?.split('\n').slice(0, 3).join(' | ') || e}`);
      process.exit(1);
    });
    const transport = openTransport(cfg, { multiplex: true });
    const code = await runDeliverd({ cfg, transport, deliveryFor: (id) => getAdapter(id)?.delivery || null, log });
    process.exit(code);
  });

// ---------------------------------------------------------------- pause / resume
/** A session on this machine by full address, or by unique label/prefix among the registered ones. */
function localAddress(input) {
  if (isAddr(input)) return input;
  const names = listRegistrations().map((r) => r.address);
  const hits = names.filter((n) => parseAddr(n).label === input || n.startsWith(input) || parseAddr(n).label.startsWith(input));
  if (hits.length === 1) return hits[0];
  throw new UsageError(hits.length ? `"${input}" matches ${hits.length} sessions here: ${hits.join(', ')}` : `no session registered on this machine matches "${input}"; use a full address`);
}
function thisAddress() {
  const { sid } = resolveSession({ session: program.opts().session, agent: resolveAgent({ agent: program.opts().agent }) });
  const st = readState(sid);
  if (!st) throw new UsageError('this session has no mailbox address yet; name one, or use --all');
  return st.address;
}
const pauseSummary = (p) => (p.all ? 'all sessions on this machine' : p.addresses.length ? p.addresses.join(', ') : 'nothing');

program
  .command('pause')
  .description('emergency stop: hold push delivery on this machine for this session, <address>, or --all (mail waits on the server)')
  .argument('[address]', 'a session address (or unique label) on this machine; default: this session')
  .option('--all', 'every session on this machine')
  .action(action(async (address, opts) => {
    const target = opts.all ? null : address ? localAddress(address) : thisAddress();
    const p = pause({ all: !!opts.all, address: target });
    console.log(`delivery paused for ${opts.all ? 'all sessions on this machine' : target}; mail waits on the server. Paused now: ${pauseSummary(p)}. Undo with: mbox resume${opts.all ? '' : ` ${target}`}`);
  }));

program
  .command('resume')
  .description('undo mbox pause: resume push delivery for <address>, or (no argument, or --all) for everything paused')
  .argument('[address]', 'a session address (or unique label) on this machine')
  .option('--all', 'everything paused (the default without an address)')
  .action(action(async (address, opts) => {
    const before = readPause();
    const target = address && !opts.all ? localAddress(address) : null;
    const p = resume({ all: !target, address: target });
    console.log(`delivery resumed for ${target || pauseSummary(before)}. Still paused: ${pauseSummary(p)}.`);
    if (target && p.all) console.log('note: all sessions are still paused; run mbox resume --all to lift that.');
  }));

// ---------------------------------------------------------------- guide
program
  .command('guide')
  .description(`short help on using the mailbox; sections: ${GUIDE_SECTIONS.join(', ')}`)
  .argument('[section]', 'which section (default: overview)')
  .action((section) => {
    const text = guideText(section);
    if (!text) {
      process.stderr.write(`mbox: no guide section "${oneLine(section, 40)}". Sections: ${GUIDE_SECTIONS.join(', ')}\n`);
      process.exit(2);
    }
    process.stdout.write(text);
    process.exit(0);
  });

// ---------------------------------------------------------------- send
async function readStdin(timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = timeoutMs ? setTimeout(() => reject(new UsageError('no message text given and nothing arrived on stdin')), timeoutMs) : null;
    process.stdin.on('data', (c) => {
      clearTimeout(timer);
      timer = null;
      chunks.push(c);
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', reject);
  });
}

program
  .command('send')
  .description('send a message to a session address, a unique prefix/label of a live peer, or "all"')
  .argument('<to>', 'full address, unique prefix/label of a live peer, or "all"')
  .argument('[text]', 'message text; "-" or omitted reads stdin')
  .option('--subject <s>', 'subject line')
  .option('--re <id>', 'id of the message this replies to')
  .action(action(async (to, text, opts) => {
    const { cfg, transport, st, agent } = await context();
    let body = text;
    if (body === '-' || (body === undefined && !process.stdin.isTTY)) body = await readStdin(body === undefined ? 3000 : 0);
    if (body === undefined || body === '') throw new UsageError('empty message: pass text as an argument or on stdin');

    let peers = [];
    let registryErr = null;
    try {
      peers = await transport.presence.list();
    } catch (e) {
      registryErr = e;
    }
    let target;
    if (to === BROADCAST || (isAddr(to) && registryErr)) target = { to, live: true };
    else if (registryErr) throw new UsageError(`cannot resolve "${to}" without the peer registry (${explainError(registryErr)}); use a full address`);
    else target = resolveTarget(to, peers);

    const envelope = buildEnvelope({ from: st.address, to: target.to, agent, subject: opts.subject, body, inReplyTo: opts.re });
    const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (cfg.maxBytes && size > cfg.maxBytes) {
      throw new UsageError(`message is ${size} bytes as an envelope but your configured limit (AGENT_MAILBOX_MAX_BYTES / "maxMessageBytes") is ${cfg.maxBytes}. Shorten it or raise the limit.`);
    }
    const res = await transport.publish(target.to, envelope);
    if (!target.live) {
      process.stderr.write(`warning: ${target.to} is not a live peer; the message is queued on the server (kept for the server's retention period, 180 days by default) until that session reads it.\n`);
    }
    console.log(res.id);
  }));

// ---------------------------------------------------------------- peers
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

program
  .command('peers')
  .description('list live sessions from the presence registry')
  .action(action(async () => {
    const { transport } = await context({ needSession: false });
    const peers = (await transport.presence.list()).filter((p) => p.live);
    if (!peers.length) {
      console.log('no live peers');
      return;
    }
    const rows = [['ADDRESS', 'ALIASES', 'AGENT', 'USER@HOST', 'CWD', 'LAST SEEN']];
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
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
  }));

// ---------------------------------------------------------------- name
program
  .command('name')
  .description('add an alias address (<user>.<host>.<label>) for this session')
  .argument('<label>', 'new label, [a-z0-9-]+')
  .action(action(async (label) => {
    const { cfg, transport, sid, st, agent } = await context();
    if (!/^[a-z0-9-]+$/.test(label)) throw new UsageError(`invalid label "${label}" (allowed: a-z 0-9 -)`);
    const me = parseAddr(st.address);
    const fitted = fitLabel(me.user, me.host, label, transport.limits.maxLabelLen(me.user, me.host));
    if (fitted !== label) throw new UsageError(`label "${label}" is too long; the longest allowed here is "${fitted}" (${fitted.length} chars)`);
    const alias = `${me.user}.${me.host}.${label}`;
    if (alias === st.address || st.aliases.includes(alias)) {
      console.log(alias);
      return;
    }
    try {
      const peers = await transport.presence.list();
      const clash = peers.find((p) => p.live && p.session !== sid && (p.address === alias || p.aliases.includes(alias)));
      if (clash) throw new UsageError(`${alias} is already used by live session ${clash.address}`);
    } catch (e) {
      if (e instanceof UsageError) throw e;
      process.stderr.write(`warning: could not check the registry for conflicts (${explainError(e)})\n`);
    }
    const next = updateState(sid, (s) => { s.aliases.push(alias); return s; });
    await transport.presence.update(presenceRecord(next, { sid, cfg, agent })).catch((e) =>
      process.stderr.write(`warning: could not announce alias (${explainError(e)})\n`));
    console.log(alias);
  }));

// ---------------------------------------------------------------- inbox
program
  .command('inbox')
  .description('print recent messages (your addresses + broadcast) without moving the watcher cursor')
  .option('--since <dur>', 'how far back (e.g. 30m, 2h, 1d)', '2h')
  .action(action(async (opts) => {
    if (!/^\d+[smhd]$/.test(opts.since)) throw new UsageError(`--since must look like 30m, 2h or 1d (got "${opts.since}")`);
    const { cfg, transport, st } = await context();
    const names = [st.address, ...st.aliases];
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[opts.since.slice(-1)];
    const deliveries = await transport.poll([...names, BROADCAST], { lookbackMs: parseInt(opts.since, 10) * unit });
    let n = 0;
    for (const d of deliveries) {
      const m = parseDelivery(d);
      if (d.to === BROADCAST && m.sender === cfg.user && names.includes(m.from)) continue;
      process.stdout.write(formatBlock(m));
      n++;
    }
    if (!n) console.log(`no messages in the last ${opts.since}`);
  }));

// ---------------------------------------------------------------- show
program
  .command('show')
  .description('print one message (to this session or a broadcast) in full, by its id')
  .argument('<id>', 'message id, as in "[mailbox] message <id>"')
  .option('--since <dur>', 'how far back to look (e.g. 2h, 7d)', '30d')
  .action(action(async (id, opts) => {
    if (!/^\d+[smhd]$/.test(opts.since)) throw new UsageError(`--since must look like 30m, 2h or 7d (got "${opts.since}")`);
    const { transport, st } = await context();
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[opts.since.slice(-1)];
    const deliveries = await transport.poll([st.address, ...st.aliases, BROADCAST], { lookbackMs: parseInt(opts.since, 10) * unit, max: Infinity });
    const hit = deliveries.map(parseDelivery).find((m) => m.id === id);
    if (!hit) {
      process.stderr.write(`mbox: no message ${oneLine(id, 140)} to this session in the last ${opts.since} (try --since 180d)\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(formatBlock(hit));
  }));

// ---------------------------------------------------------------- setup
program
  .command('setup')
  .description('write the client config (~/.config/agent-mailbox/config.json, mode 0600)')
  .requiredOption('--servers <urls>', 'mailbox server URL(s), comma-separated')
  .requiredOption('--user <name>', 'your mailbox user name ([a-z0-9-]+)')
  .option('--password-stdin', 'read the password from stdin (the only way to pass it; never on the command line)')
  .action(action(async (opts) => {
    const servers = splitServers(opts.servers);
    if (!servers.length) throw new UsageError('--servers is empty');
    for (const s of servers) {
      try { validateServer(s); } catch (e) { throw new UsageError(`--servers: ${e.message}`); }
    }
    if (!/^[a-z0-9-]+$/.test(opts.user)) throw new UsageError('--user must match [a-z0-9-]+');
    if (!opts.passwordStdin) throw new UsageError('pass --password-stdin and pipe the password in, e.g.  printf \'%s\\n\' "$PW" | mbox setup ... --password-stdin');
    const password = (await readStdin(process.stdin.isTTY ? 0 : 3000)).split(/\r?\n/)[0];
    if (!password) throw new UsageError('no password arrived on stdin');
    const p = writeConfig({ servers, user: opts.user, password });
    console.log(`wrote ${p} (mode 0600). Verify with: mbox doctor`);
  }));

// ---------------------------------------------------------------- doctor
program
  .command('doctor')
  .description('check configuration, connectivity, auth and permissions')
  .action(async () => {
    let cfg;
    let transport;
    try {
      cfg = loadConfig();
      transport = openTransport(cfg);
      console.log(`ok    config present (${configPath()}; servers ${cfg.servers.join(',')}, user ${cfg.user})`);
    } catch (e) {
      console.log(`FAIL  config\n      -> ${e.message}`);
      process.exit(1);
    }
    let bad = 0;
    for (const c of await transport.diagnose({ user: cfg.user, host: shortHost() })) {
      if (!c.ok) bad++;
      console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${!c.ok && c.hint ? `\n      -> ${c.hint}` : ''}`);
    }
    console.log(bad ? `\n${bad} problem(s) found` : '\nall checks passed');
    await closeTransports();
    process.exit(bad ? 1 : 0);
  });

// ---------------------------------------------------------------- hook
program
  .command('hook')
  .description('agent hook entry point: mbox hook <agent> <event>  (e.g. mbox hook claude-code session-start)')
  .argument('<agent>', 'adapter id')
  .argument('<event>', 'hook event name')
  .action(async (agentId, event) => {
    // A hook must never break the host agent: always exit 0.
    try {
      const adapter = getAdapter(agentId);
      const handler = adapter?.hooks?.[event];
      if (!handler) {
        process.stderr.write(`mbox hook: no handler for ${agentId} ${event}\n`);
        process.exit(0);
      }
      let input = {};
      if (!process.stdin.isTTY) {
        try {
          input = JSON.parse((await readStdin(1500)) || '{}');
        } catch {
          input = {};
        }
      }
      let cfg = null;
      let transport = null;
      let configError = null;
      try {
        cfg = loadConfig();
        transport = openTransport(cfg);
      } catch (e) {
        configError = e.message;
      }
      const ctx = {
        env: process.env,
        sessionOverride: program.opts().session || process.env.AGENT_MAILBOX_SESSION || null,
        launcher: launcherPath(),
        configError,
        ensure: (sid, cwd) => ensureSession({ sid, cfg, transport, cwd, hostPid: adapter.hostPid(process.env) }),
        endSession: (sid) => endSession({ sid, cfg, transport, agent: adapter.id }),
        register: (reg) => register(reg),
        deregister: (sid) => deregister(sid),
        startDeliverd,
      };
      const out = await handler(input, ctx);
      if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    } catch (e) {
      process.stderr.write(`mbox hook: ${e.message}\n`);
    }
    await closeTransports();
    process.exit(0);
  });

program.configureOutput({ outputError: (s, write) => write(s) });
await program.parseAsync(process.argv).catch(fail);
