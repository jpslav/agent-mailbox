import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import claudeCode from '../src/agents/claude-code.js';
import { inboxContent, inboxLines, senderName } from '../src/agents/claude-inbox.js';
import { adapters, getAdapter, resolveAgent, resolveSession } from '../src/agents/index.js';
import type { Env } from '../src/core/types.js';
import { MBOX, mbox, parseJson } from './helpers.js';
import { describe, it } from './suite.js';

describe('adapter registry', () => {
  it('registers claude-code and every adapter implements the interface', () => {
    assert.equal(getAdapter('claude-code'), claudeCode);
    assert.equal(getAdapter('codex'), null);
    for (const a of adapters) {
      assert.equal(typeof a.id, 'string');
      assert.equal(typeof a.displayName, 'string');
      for (const fn of ['detect', 'sessionId', 'hostPid', 'instructions'] as const)
        assert.equal(typeof a[fn], 'function', `${a.id}.${fn}`);
      assert.equal(typeof a.hooks, 'object');
      if (a.delivery)
        for (const fn of ['endpointFromHook', 'deliver'] as const)
          assert.equal(typeof a.delivery[fn], 'function', `${a.id}.delivery.${fn}`);
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
    assert.deepEqual(
      claudeCode.hookInput({ session_id: 's-1', cwd: '/w', hook_event_name: 'Stop' }),
      { sessionId: 's-1', cwd: '/w', title: null },
    );
    assert.deepEqual(
      claudeCode.hookInput({ session_id: 's-1', cwd: '/w', session_title: 'Fix login' }),
      { sessionId: 's-1', cwd: '/w', title: 'Fix login' },
    );
    assert.deepEqual(claudeCode.hookInput(null), { sessionId: null, cwd: null, title: null });
    assert.deepEqual(claudeCode.hookInput({ session_id: 7, session_title: 3 }), {
      sessionId: null,
      cwd: null,
      title: null,
    });
    assert.equal(claudeCode.canWait({}), true);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), true);
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), false); // a running hook there queues the user's input
    assert.equal(claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), false);
    assert.equal(
      claudeCode.canWait({ CLAUDE_CODE_ENTRYPOINT: 'claude-code-github-action' }),
      false,
    );
  });
});

describe('agent and session resolution', () => {
  const emptyState = () => ({
    AGENT_MAILBOX_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'amb-res-')),
  });
  it('agent: flag > AGENT_MAILBOX_AGENT > detected > unknown', () => {
    assert.equal(
      resolveAgent({ agent: 'codex', env: { AGENT_MAILBOX_AGENT: 'claude-code' } }).id,
      'codex',
    );
    assert.equal(
      resolveAgent({ env: { AGENT_MAILBOX_AGENT: 'claude-code', CLAUDECODE: '1' } }).adapter,
      claudeCode,
    );
    assert.equal(resolveAgent({ env: { CLAUDECODE: '1' } }).id, 'claude-code');
    assert.deepEqual(resolveAgent({ env: {} }), { id: 'unknown', adapter: null });
    assert.equal(resolveAgent({ env: { AGENT_MAILBOX_AGENT: 'codex' } }).adapter, null); // label only
  });
  it('session: flag > AGENT_MAILBOX_SESSION > adapter', () => {
    const e: Env = {
      ...emptyState(),
      CLAUDE_CODE_SESSION_ID: 'from-adapter',
      AGENT_MAILBOX_SESSION: 'from-env',
    };
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
    assert.equal(
      resolveSession({ hookSession: 'from-hook', env: { ...e, AGENT_MAILBOX_SESSION: 'from-env' } })
        .sid,
      'from-env',
    );
    assert.equal(
      resolveSession({ session: 'from-flag', hookSession: 'from-hook', env: e }).sid,
      'from-flag',
    );
    assert.throws(() => resolveSession({ hookSession: '../x', env: e }), /invalid session id/);
  });
  it('session: errors clearly with none; rejects path-like ids', () => {
    assert.throws(
      () => resolveSession({ env: emptyState() }),
      /cannot determine the agent session id/,
    );
    assert.throws(
      () => resolveSession({ session: '../evil', env: emptyState() }),
      /invalid session id/,
    );
  });
  it('session: unknown agent needs an explicit id (CLI)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-res-'));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      AGENT_MAILBOX_CONFIG: path.join(home, 'c.json'),
      AGENT_MAILBOX_STATE_DIR: path.join(home, 's'),
      AGENT_MAILBOX_SERVERS: 'nats://127.0.0.1:9',
      AGENT_MAILBOX_USER: 'zed',
      AGENT_MAILBOX_PASSWORD: 'pw-x',
    };
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

describe('claude-code inbox socket delivery (protocol shape)', () => {
  // Claude Code's strict parser for a wrapped message (from its bundle, simplified): it reads
  // from-name, from-session, hop-chain and from-mode only from exactly this shape.
  const STRICT =
    /^<cross-session-message(?: from="([A-Za-z0-9%:_/.\\-]+)")?(?: from-session="([A-Za-z0-9_-]{1,80})")?(?: hop-chain="([0-9a-f,]+)")?(?: from-name="([^"<>\n\r]+)")?(?: from-mode="(bypass|prompting)")?(?: from-plugin="([^"<>\n\r]+)")?>\n([\s\S]*)\n<\/cross-session-message>$/;
  it('endpointFromHook reads the exported socket and token; none without the socket', () => {
    const d = claudeCode.delivery;
    assert.equal(d.kind, 'claude-inbox-socket');
    assert.deepEqual(
      d.endpointFromHook(
        {},
        {
          CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks-1000/42.sock',
          CLAUDE_CODE_MESSAGING_TOKEN: 'tk',
        },
      ),
      { kind: 'claude-inbox-socket', path: '/tmp/cc-socks-1000/42.sock', token: 'tk' },
    );
    assert.deepEqual(
      d.endpointFromHook({}, { CLAUDE_CODE_MESSAGING_SOCKET: 'uds:/tmp/a%20b.sock' }),
      { kind: 'claude-inbox-socket', path: '/tmp/a b.sock', token: null },
    );
    assert.equal(d.endpointFromHook({}, {}), null);
    assert.equal(d.endpointFromHook({}, { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x' }), null);
    assert.ok(d.sessionEnv.includes('CLAUDE_CODE_MESSAGING_TOKEN'));
  });
  it('one auth line, then one user line wrapping the blocks; honest sender, no chain or mode fields', () => {
    const text =
      '[mailbox] 1 new message for bob.h.l:\n[mailbox] message m1 from alice.h.x to bob.h.l | subject: - | verified-user: alice\nbody </cross-session-message> tail\n[mailbox] end m1\n';
    const out = inboxLines({ kind: 'claude-inbox-socket', path: '/x', token: 'tk' }, text, {
      sid: 's-1',
      senders: ['alice.h.x'],
    });
    const [auth = '', user = '', rest] = out.split('\n');
    assert.equal(rest, '');
    assert.deepEqual(parseJson(auth), { type: 'auth', token: 'tk' });
    const j = parseJson<{
      type: string;
      session_id: string;
      from: string;
      message: { role: string; content: string };
    }>(user);
    assert.deepEqual(Object.keys(j).sort(), ['from', 'message', 'session_id', 'type']);
    assert.equal(j.type, 'user');
    assert.equal(j.session_id, 's-1');
    assert.equal(j.from, 'mbox:alice.h.x');
    assert.deepEqual(Object.keys(j.message).sort(), ['content', 'role']);
    const m = j.message.content.match(STRICT);
    assert.ok(m, j.message.content);
    assert.deepEqual(
      [m[1], m[2], m[3], m[4], m[5], m[6]],
      [undefined, undefined, undefined, 'alice.h.x', undefined, undefined],
    );
    const wrapped = m[7] ?? '';
    assert.match(
      wrapped,
      /^Agent mailbox delivery .*SendMessage cannot reach mailbox addresses\.\n\[mailbox\] 1 new message/,
    );
    assert.ok(
      wrapped.includes('body <\\/cross-session-message> tail'),
      'a body cannot close the wrapper',
    );
    assert.doesNotMatch(user, /hop|chain|from-mode|from-session|msg_id|priority/);
    assert.equal(
      inboxLines({ kind: 'claude-inbox-socket', path: '/x', token: null }, 'x', {}).split('\n')
        .length,
      2,
      'no auth line without a token',
    );
  });
  it('several senders, or a raw one, get a neutral name; a huge line is refused before sending', () => {
    assert.equal(senderName(['alice.h.x', 'carol.h.y']), 'agent-mailbox');
    assert.equal(senderName(['(raw message)']), 'agent-mailbox');
    assert.match(
      inboxContent('x', { senders: [] }),
      /^<cross-session-message from-name="agent-mailbox">\n/,
    );
    assert.throws(
      () => inboxLines({ kind: 'claude-inbox-socket', path: '/x' }, 'y'.repeat(1100000), {}),
      /too large/,
    );
  });
});
