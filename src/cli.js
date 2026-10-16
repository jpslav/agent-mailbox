import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { getAdapter, resolveAgent, resolveSession } from './agents/index.js';
import { BROADCAST, fitLabel, isAddr, parseAddr, shortHost } from './core/addr.js';
import { ConfigError, configPath, loadConfig, splitServers, writeConfig } from './core/config.js';
import { buildEnvelope, formatBlock, oneLine, parseDelivery } from './core/envelope.js';
import { ResolveError, presenceRecord, resolveTarget } from './core/registry.js';
import { NoSessionError, ensureSession, updateState } from './core/state.js';
import { createTransport, explainError, validateServer } from './core/transport/nats.js'; // composition root: the only place that picks the broker
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

// Every transport created by a command; closed before the process exits.
const transports = [];
function openTransport(cfg) {
  const t = createTransport(cfg);
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
  .description('stream incoming messages to stdout (run as the agent\'s monitor / background process)')
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
