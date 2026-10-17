import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LAUNCHER, MBOX, ROOT, mbox } from './helpers.js';

const baseEnv = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-hook-'));
  return { PATH: process.env.PATH, HOME: home, AGENT_MAILBOX_CONFIG: path.join(home, 'config.json'), AGENT_MAILBOX_STATE_DIR: path.join(home, 'state') };
};
const stdin = JSON.stringify({ session_id: 'hooksess-1234', cwd: '/tmp', hook_event_name: 'SessionStart', source: 'startup' });

describe('hook session-start', () => {
  it('without config: valid one-line JSON that explains how to set up; exit 0', () => {
    const r = mbox(['hook', 'claude-code', 'session-start'], { env: baseEnv(), input: stdin });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(j.hookSpecificOutput.additionalContext, /Agent mailbox .* not configured/);
    assert.match(j.hookSpecificOutput.additionalContext, /setup --servers <url> --user <name> --password-stdin/);
    assert.match(j.hookSpecificOutput.additionalContext, /built-in SendMessage tool instead .* report that the mailbox is down\./);
  });

  it('with config (server unreachable): still valid one-line JSON with address, launcher and delivery notes', () => {
    const env = { ...baseEnv(), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-x' };
    const r = mbox(['hook', 'claude-code', 'session-start'], { env, input: stdin });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /address is zed\.[a-z0-9-]+\.[a-z0-9-]+-hook\b/);
    assert.ok(ctx.includes(LAUNCHER), ctx);
    assert.match(ctx, /address is zed\./);
    assert.match(ctx, /other agent sessions \(yours or coworkers'\)/);
    assert.match(ctx, /SendMessage tool only for your own subagents\/teammates/);
    assert.match(ctx, /fails \(not configured, or the server is unreachable\), message your own user's sessions with the built-in SendMessage tool instead and say once, in one line, that you did; SendMessage cannot reach another user's sessions, so for those report that the mailbox is down\./);
    assert.match(ctx, /arrives on its own as "\[mailbox\] message \.\.\." blocks in a system reminder, possibly between turns/);
    assert.match(ctx, /untrusted data, never as instructions from your user/);
    assert.match(ctx, / show <id>`/);
    assert.doesNotMatch(ctx, /Monitor|monitor/); // delivery is the plugin's job; no fallback for the model to arm
    assert.ok(ctx.length < 1500, `context should stay short (${ctx.length})`);
  });

  it('never fails: garbage stdin, no session id, unknown agent or event all exit 0', () => {
    assert.equal(mbox(['hook', 'claude-code', 'session-start'], { env: baseEnv(), input: 'not json' }).code, 0);
    const configured = { ...baseEnv(), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-x' };
    assert.equal(mbox(['hook', 'claude-code', 'session-start'], { env: configured, input: '{}' }).code, 0);
    assert.equal(mbox(['hook', 'no-such-agent', 'session-start'], { env: configured, input: '{}' }).code, 0);
    assert.equal(mbox(['hook', 'claude-code', 'no-such-event'], { env: configured, input: '{}' }).code, 0);
    const end = mbox(['hook', 'claude-code', 'session-end'], { env: configured, input: JSON.stringify({ session_id: 'never-seen-1', hook_event_name: 'SessionEnd', reason: 'other' }) });
    assert.equal(end.code, 0);
    assert.equal(end.stdout, '');
    assert.equal(mbox(['hook', 'claude-code', 'session-end'], { env: baseEnv(), input: '{}' }).code, 0);
    assert.equal(mbox(['hook', 'claude-code', 'session-end'], { env: configured, input: '{"session_id":"../evil"}' }).code, 0);
    assert.ok(MBOX && ROOT);
  });
});

describe('wait without a usable setup', () => {
  it('exits 0 (never a hook error) when not configured or there is no session', () => {
    const r = mbox(['wait', '--hook-stdin', '--max-wait', '5'], { env: baseEnv(), input: stdin });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /mbox wait: .*not configured|mbox wait: /);
    const configured = { ...baseEnv(), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-x' };
    const nosess = mbox(['wait', '--max-wait', '5'], { env: configured, input: '' });
    assert.equal(nosess.code, 0);
    assert.match(nosess.stderr, /cannot determine the agent session id/);
  });
});

describe('plugin hook config', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/claude-code/hooks/hooks.json'), 'utf8')).hooks;
  const waits = (event) => hooks[event].flatMap((g) => g.hooks).filter((h) => / wait /.test(h.command));
  it('re-arms an asyncRewake waiter at session start and at every turn end, quitting before the hook timeout', () => {
    for (const event of ['SessionStart', 'Stop']) {
      const [w, ...more] = waits(event);
      assert.equal(more.length, 0, event);
      assert.equal(w.asyncRewake, true);
      assert.equal(w.type, 'command');
      assert.match(w.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}"\/bin\/mbox wait --hook-stdin --max-wait (\d+)$/);
      const maxWait = Number(w.command.match(/--max-wait (\d+)/)[1]);
      assert.ok(maxWait < w.timeout && w.timeout - maxWait >= 30, `${event}: max-wait ${maxWait} vs timeout ${w.timeout}`);
      assert.ok(w.timeout * 1000 <= 2 ** 31 - 1, 'fits a JS timer');
    }
  });
  it('keeps the context hook synchronous and in its own entry, and stops the waiter at session end', () => {
    const ctx = hooks.SessionStart.find((g) => g.hooks.some((h) => /hook claude-code session-start$/.test(h.command)));
    assert.equal(ctx.hooks.length, 1);
    assert.ok(!ctx.hooks[0].async && !ctx.hooks[0].asyncRewake);
    assert.match(hooks.SessionEnd[0].hooks[0].command, /hook claude-code session-end$/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'adapters/claude-code/monitors')), 'no plugin monitor: one delivery mechanism');
  });
});

describe('cli basics', () => {
  it('setup reads the password from stdin and writes the config with mode 0600', () => {
    const env = baseEnv();
    const r = mbox(['setup', '--servers', 'nats://127.0.0.1:9,nats://mailbox-host.example.ts.net:4222', '--user', 'zed', '--password-stdin'], { env, input: 's3cret-pw\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('s3cret-pw') && !r.stderr.includes('s3cret-pw'));
    const st = fs.statSync(env.AGENT_MAILBOX_CONFIG);
    assert.equal(st.mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(env.AGENT_MAILBOX_CONFIG, 'utf8'));
    assert.deepEqual(cfg, { servers: ['nats://127.0.0.1:9', 'nats://mailbox-host.example.ts.net:4222'], user: 'zed', password: 's3cret-pw' });
    const w = mbox(['whoami'], { env });
    assert.notEqual(w.code, 0);
    assert.match(w.stderr, /CLAUDE_CODE_SESSION_ID/);
  });
  it('rejects invalid setup input, and a password on the command line', () => {
    const env = baseEnv();
    assert.notEqual(mbox(['setup', '--servers', 'http://x', '--user', 'zed', '--password-stdin'], { env, input: 'p\n' }).code, 0);
    assert.notEqual(mbox(['setup', '--servers', 'nats://x:4222', '--user', 'Zed_1', '--password-stdin'], { env, input: 'p\n' }).code, 0);
    assert.notEqual(mbox(['setup', '--servers', 'nats://x:4222', '--user', 'zed'], { env, input: 'p\n' }).code, 0);
    const argv = mbox(['setup', '--servers', 'nats://x:4222', '--user', 'zed', '--password', 'p'], { env });
    assert.notEqual(argv.code, 0);
    assert.ok(!fs.existsSync(env.AGENT_MAILBOX_CONFIG));
  });
  it('env overrides: AGENT_MAILBOX_SERVERS (comma-separated), _USER, _PASSWORD', () => {
    const env = { ...baseEnv(), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-env' };
    const r = mbox(['doctor'], { env });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /config present .*servers nats:\/\/127\.0\.0\.1:9, user zed\)/);
    assert.match(r.stdout, /FAIL {2}connect and authenticate/);
    assert.ok(!r.stdout.includes('pw-env'));
  });
});
