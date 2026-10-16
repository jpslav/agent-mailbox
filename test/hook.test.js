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
  });

  it('with config (server unreachable): still valid one-line JSON with address, launcher and Monitor instructions', () => {
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
    assert.match(ctx, /agent-mailbox monitor/);
    assert.match(ctx, /Monitor tool/);
    assert.match(ctx, /1800000/);
    assert.match(ctx, /--session hooksess-1234/);
    assert.ok(ctx.length < 1500, `context should stay short (${ctx.length})`);
  });

  it('never fails: garbage stdin, no session id, unknown agent or event all exit 0', () => {
    assert.equal(mbox(['hook', 'claude-code', 'session-start'], { env: baseEnv(), input: 'not json' }).code, 0);
    const configured = { ...baseEnv(), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-x' };
    assert.equal(mbox(['hook', 'claude-code', 'session-start'], { env: configured, input: '{}' }).code, 0);
    assert.equal(mbox(['hook', 'no-such-agent', 'session-start'], { env: configured, input: '{}' }).code, 0);
    assert.equal(mbox(['hook', 'claude-code', 'no-such-event'], { env: configured, input: '{}' }).code, 0);
    assert.ok(MBOX && ROOT);
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
