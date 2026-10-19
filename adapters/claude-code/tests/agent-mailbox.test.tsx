// The mailbox panel's hooks module under `claude plugin test adapters/claude-code` (npm run
// test:plugin): the engine's own test kit, the plugin loaded from this folder. The world beneath
// the plugin (mbox, the clock, the store) is mocked here.
import { expect, mock, test } from 'claude-code/testing';
import type { On, ProcessRunResult } from 'claude-code';

import { asSnapshot, clean, groupPeers } from '../hooks/model';

const SNAPSHOT = {
  v: 1,
  at: 1000,
  since: '24h',
  socket: null,
  self: {
    address: 'alice.laptop.demo-1a2b',
    aliases: [],
    user: 'alice',
    host: 'laptop',
    title: 'Prototype the panel',
    status: null,
    role: null,
    parent: null,
    offers: ['repo:github.com/owner/repo'],
    services: [],
    repo: 'owner/repo',
    branch: 'main',
  },
  peers: [
    {
      address: 'bob.desk.helper-9f9f',
      aliases: [],
      user: 'bob',
      host: 'desk',
      agent: 'claude-code',
      title: 'Review the parser',
      status: null,
      role: null,
      parent: null,
      repo: null,
      branch: null,
      offers: [],
      services: [],
      lastSeen: 900,
      relation: 'correspondent',
    },
  ],
  mail: [
    {
      id: 'm1',
      from: 'bob.desk.helper-9f9f',
      to: 'alice.laptop.demo-1a2b',
      kind: 'direct',
      area: null,
      subject: null,
      body: 'hello [x](https://evil.example)',
      isTruncated: false,
      verifiedUser: 'bob',
      isMismatch: false,
      inReplyTo: null,
      sentAt: null,
      time: 800,
    },
  ],
  sent: [],
  threads: [
    {
      with: 'bob.desk.helper-9f9f',
      kind: 'direct',
      lastAt: 800,
      count: 2,
      isAwaitingMe: true,
      messages: [
        {
          id: 's1',
          dir: 'out',
          time: 700,
          subject: null,
          firstLine: 'can you look?',
          inReplyTo: null,
        },
        {
          id: 'm1',
          dir: 'in',
          time: 800,
          subject: null,
          firstLine: 'hello [x](https://evil.example)',
          inReplyTo: 's1',
        },
      ],
    },
  ],
  areas: [{ area: 'repo:github.com/owner/repo', offeredBy: 0, isMine: true }],
};

/** `/mbox` typed in the composer. */
const MBOX = {
  command: 'mbox',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
};

const ok = (stdout: string, exitCode = 0, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
});

const PANE_PROPS = {
  title: 'Mailbox',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
};
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 5,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
};

/** The world beneath the plugin: an mbox that answers a snapshot, and what was run and copied. */
function world(on: On): { spawned: string[][]; bins: string[]; copies: string[] } {
  const spawned: string[][] = [];
  const bins: string[] = [];
  const copies: string[] = [];
  mock.store(on);
  on('process.run', (_$, e) => {
    bins.push(e.argv[0] ?? '');
    const args = e.argv.slice(1);
    spawned.push([...args]);
    if (args[0] === 'snapshot') return { value: ok(JSON.stringify(SNAPSHOT)) };
    return { value: ok('') };
  });
  on('session.id', () => ({ value: 'session-1' }));
  on('session.receive', (_$, e) => ({ text: e.text }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.panes', () => ({ value: [] }));
  on('ui.open', () => ({ value: { isPlaced: true as const } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface}:${e.text}`);
    return { value: { isCopied: true as const } };
  });
  return { spawned, bins, copies };
}

test('model: snapshot checks and peer groups', () => {
  expect(asSnapshot({ v: 2 })).toBeNull();
  expect(asSnapshot({ v: 1, self: {} })).toBeNull();
  const s = asSnapshot(SNAPSHOT);
  expect(s?.threads[0]?.count).toBe(2);
  expect(groupPeers(s?.peers ?? []).close.length).toBe(1);
  expect(clean('a\u001b[31mb\u202ec\nd')).toBe('a [31mb c d');
});

test('nothing runs until /mbox opens the panel; the band is off by default', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const { spawned, bins } = world(on);
  // The engine's own band beneath the plugin.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine band</Text>;
  });
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await clock.settle();
  await clock.advance(30 * 60_000);
  expect(spawned).toEqual([]);
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'agent-mailbox',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS,
    });
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: /mbox / })).toBeUndefined();
    await band.unmount();
  }

  const r = await $.command.run(MBOX);
  expect(r.text).toBe('Mailbox panel opened (placed).');
  await clock.settle();
  expect(spawned).toEqual([['snapshot', '--json', '--since', '24h']]);
  // The plugin's own launcher, never a PATH lookup.
  expect(bins.every((b) => b.endsWith('/bin/mbox') && b.startsWith('/'))).toBe(true);
});

test('panel: session card, conversations, untrusted text as plain Text', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const { copies } = world(on);
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  await $.command.run(MBOX);
  await clock.settle();

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'agent-mailbox',
      surface,
      component: 'Pane',
      requestId: 'mbox',
      props: PANE_PROPS,
    });
    expect(await pane.find({ type: 'Text', text: 'alice.laptop.demo-1a2b' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /Prototype the panel/ })).toBeDefined();
    // Open a conversation: both directions show, the untrusted text as plain Text only.
    await pane.press({ key: 't:bob.desk.helper-9f9f' });
    expect(await pane.find({ type: 'Text', text: /can you look\?/ })).toBeDefined();
    expect(await pane.find({ type: 'Markdown' })).toBeUndefined();
    expect(await pane.find({ type: 'Link' })).toBeUndefined();
    await pane.press({ key: 't:bob.desk.helper-9f9f' });
    // The correspondent heads its conversation by its title and is not listed again below.
    expect(await pane.find({ type: 'Button', text: /Review the parser/ })).toBeDefined();
    expect(await pane.find({ key: 'p:bob.desk.helper-9f9f' })).toBeUndefined();
    // Help lives in the session card: offers as chips, the ask form behind a toggle.
    expect(await pane.find({ key: 'unoffer:repo:github.com/owner/repo' })).toBeDefined();
    await pane.press({ key: 'ask-toggle' });
    expect(await pane.find({ key: 'ask-text' })).toBeDefined();
    await pane.press({ key: 'ask-toggle' });
    await pane.press({ key: 'copy' });
    expect(await pane.find({ type: 'Text', text: '✓' })).toBeDefined();
    await pane.unmount();
  }
  expect(copies).toEqual(['terminal:alice.laptop.demo-1a2b', 'desktop:alice.laptop.demo-1a2b']);
});

test(
  'the band, with the option on; a delivery refreshes',
  { options: { band: true } },
  async ($, on) => {
    const clock = mock.clock(on, { now: 1000 });
    const { spawned, copies } = world(on);
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.settle();
    expect(spawned).toEqual([['snapshot', '--json', '--since', '24h']]);

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({
        plugin: 'agent-mailbox',
        surface,
        component: 'AbovePrompt',
        props: BAND_PROPS,
      });
      expect(await band.find({ type: 'Text', text: /1 awaiting you/ })).toBeDefined();
      await band.press({ key: 'band-copy' });
      await band.unmount();
    }
    expect(copies).toEqual(['terminal:alice.laptop.demo-1a2b', 'desktop:alice.laptop.demo-1a2b']);

    // With the pane closed, a spawn source refreshes every 10 minutes, not every minute.
    const before = spawned.length;
    await clock.advance(5 * 60_000);
    expect(spawned.length).toBe(before);
    await clock.advance(5 * 60_000 + 20_000);
    expect(spawned.length).toBe(before + 1);

    // A delivery: one refresh shortly after.
    await $.session.receive({
      origin: { kind: 'unclassified' },
      text: '[mailbox] message m2 from x to y',
    });
    await clock.advance(2000);
    expect(spawned.length).toBe(before + 2);
  },
);
