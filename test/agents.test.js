import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import claudeCode from '../src/agents/claude-code.js';
import { adapters, getAdapter, resolveAgent, resolveSession } from '../src/agents/index.js';
import { MBOX, mbox } from './helpers.js';

describe('adapter registry', () => {
  it('registers claude-code and every adapter implements the interface', () => {
    assert.equal(getAdapter('claude-code'), claudeCode);
    assert.equal(getAdapter('codex'), null);
    for (const a of adapters) {
      assert.equal(typeof a.id, 'string');
      assert.equal(typeof a.displayName, 'string');
      for (const fn of ['detect', 'sessionId', 'hostPid', 'instructions']) assert.equal(typeof a[fn], 'function', `${a.id}.${fn}`);
      assert.equal(typeof a.hooks, 'object');
    }
  });
  it('claude-code detect / sessionId / hostPid', () => {
    assert.equal(claudeCode.detect({}), false);
    assert.equal(claudeCode.detect({ CLAUDECODE: '1' }), true);
    assert.equal(claudeCode.detect({ CLAUDE_CODE_SESSION_ID: 'x' }), true);
    assert.equal(claudeCode.sessionId({ CLAUDE_CODE_SESSION_ID: 'abc' }), 'abc');
    assert.equal(claudeCode.sessionId({}), null);
    assert.equal(claudeCode.hostPid({ CLAUDE_PID: '4242' }), 4242);
    assert.equal(claudeCode.hostPid({ CLAUDE_PID: 'x' }), null);
    assert.equal(claudeCode.hostPid({}), null);
  });
  it('claude-code hookInput / canWait', () => {
    assert.deepEqual(claudeCode.hookInput({ session_id: 's-1', cwd: '/w', hook_event_name: 'Stop' }), { sessionId: 's-1', cwd: '/w' });
    assert.deepEqual(claudeCode.hookInput(null), { sessionId: null, cwd: null });
    assert.deepEqual(claudeCode.hookInput({ session_id: 7 }), { sessionId: null, cwd: null });
    assert.equal(claudeCode.canWait({}), true);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), true);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), true);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), false);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'claude-code-github-action' }), false);
  });
});

describe('agent and session resolution', () => {
  const emptyState = () => ({ AGENT_MAILBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'amb-res-')) });
  it('agent: flag > AGENT_MAILBOX_AGENT > detected > unknown', () => {
    assert.equal(resolveAgent({ agent: 'codex', env: { AGENT_MAILBOX_AGENT: 'claude-code' } }).id, 'codex');
    assert.equal(resolveAgent({ env: { AGENT_MAILBOX_AGENT: 'claude-code', CLAUDECODE: '1' } }).adapter, claudeCode);
    assert.equal(resolveAgent({ env: { CLAUDECODE: '1' } }).id, 'claude-code');
    assert.deepEqual(resolveAgent({ env: {} }), { id: 'unknown', adapter: null });
    assert.equal(resolveAgent({ env: { AGENT_MAILBOX_AGENT: 'codex' } }).adapter, null); // label only
  });
  it('session: flag > AGENT_MAILBOX_SESSION > adapter', () => {
    const e = { ...emptyState(), CLAUDE_CODE_SESSION_ID: 'from-adapter', AGENT_MAILBOX_SESSION: 'from-env' };
    assert.equal(resolveSession({ session: 'from-flag', env: e }).sid, 'from-flag');
    assert.equal(resolveSession({ env: e }).sid, 'from-env');
    delete e.AGENT_MAILBOX_SESSION;
    const r = resolveSession({ env: e });
    assert.equal(r.sid, 'from-adapter');
    assert.equal(r.agent, 'claude-code');
  });
  it('session: a hook payload comes after the flag and AGENT_MAILBOX_SESSION, before the adapter', () => {
    const e = { ...emptyState(), CLAUDE_CODE_SESSION_ID: 'from-adapter' };
    assert.equal(resolveSession({ hookSession: 'from-hook', env: e }).sid, 'from-hook');
    assert.equal(resolveSession({ hookSession: 'from-hook', env: { ...e, AGENT_MAILBOX_SESSION: 'from-env' } }).sid, 'from-env');
    assert.equal(resolveSession({ session: 'from-flag', hookSession: 'from-hook', env: e }).sid, 'from-flag');
    assert.throws(() => resolveSession({ hookSession: '../x', env: e }), /invalid session id/);
  });
  it('session: errors clearly with none; rejects path-like ids', () => {
    assert.throws(() => resolveSession({ env: emptyState() }), /cannot determine the agent session id/);
    assert.throws(() => resolveSession({ session: '../evil', env: emptyState() }), /invalid session id/);
  });
  it('session: unknown agent needs an explicit id (CLI)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-res-'));
    const env = { PATH: process.env.PATH, HOME: home, AGENT_MAILBOX_CONFIG: path.join(home, 'c.json'), AGENT_MAILBOX_STATE_DIR: path.join(home, 's'), AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9', AGENT_MAILBOX_USER: 'zed', AGENT_MAILBOX_PASSWORD: 'pw-x' };
    const bad = mbox(['whoami'], { env });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /AGENT_MAILBOX_SESSION/);
    const viaFlag = mbox(['--agent', 'codex', '--session', 'codex-1', 'whoami'], { env });
    assert.equal(viaFlag.code, 0, viaFlag.stderr);
    assert.match(viaFlag.stdout, /^zed\.[a-z0-9-]+\.[a-z0-9-]+-code\n/);
    const viaDetect = mbox(['whoami'], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'abcd-1' } });
    assert.equal(viaDetect.code, 0, viaDetect.stderr);
    assert.ok(MBOX);
  });
});
