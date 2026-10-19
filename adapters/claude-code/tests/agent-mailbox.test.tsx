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
function world(
  on: On,
  version = '2.1.299',
  snapshot: object = SNAPSHOT,
): {
  spawned: string[][];
  bins: string[];
  copies: string[];
  stdins: string[];
  panes: Set<string>;
} {
  // The panes the engine holds open, as $.ui.panes() answers.
  const panes = new Set<string>();
  const spawned: string[][] = [];
  const stdins: string[] = [];
  const bins: string[] = [];
  const copies: string[] = [];
  mock.store(on);
  on('process.run', (_$, e) => {
    bins.push(e.argv[0] ?? '');
    const args = e.argv.slice(1);
    spawned.push([...args]);
    if (e.init?.stdin !== undefined) stdins.push(e.init.stdin);
    if (args[0] === 'snapshot') return { value: ok(JSON.stringify(snapshot)) };
    return { value: ok('') };
  });
  on('session.id', () => ({ value: 'session-1' }));
  on('session.version', () => ({ value: { version } }));
  on('classic.UserPromptSubmit', () => ({}));
  on('classic.SessionStart', () => ({}));
  on('session.receive', (_$, e) => ({ text: e.text }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.panes', () => ({
    value: [...panes].map((id) => ({
      id,
      title: 'Mailbox',
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })),
  }));
  on('ui.open', (_$, e) => {
    panes.add(e.id);
    return { value: { isPlaced: true as const } };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('ui.copy', (_$, e) => {
    copies.push(`${e.surface}:${e.text}`);
    return { value: { isCopied: true as const } };
  });
  return { spawned, bins, copies, stdins, panes };
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

test(
  'an older Claude Code: /mbox says what it needs, nothing else runs',
  { options: { band: true } },
  async ($, on) => {
    const clock = mock.clock(on, { now: 1000 });
    const { spawned } = world(on, '2.1.290');
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>engine band</Text>;
    });
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.settle();
    const r = await $.command.run(MBOX);
    expect(r.text).toMatch(/needs Claude Code 2\.1\.299 or newer \(this is 2\.1\.290\)/);
    const band = await $.ui.mount({
      plugin: 'agent-mailbox',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    });
    expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined();
    await band.unmount();
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'A title' });
    await clock.advance(30 * 60_000);
    expect(spawned).toEqual([]);
  },
);

test('title sharing: published as it changes, cleared once when turned off', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const { spawned } = world(on);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.classic.UserPromptSubmit({ prompt: 'a', session_title: 'Port the panel' });
  await $.classic.UserPromptSubmit({ prompt: 'b', session_title: 'Port the panel' });
  await clock.settle();
  expect(spawned).toEqual([['title', '--', 'Port the panel']]);
  // A resume: the command hook published the same title, so the next prompt runs nothing.
  await $.classic.SessionStart({ source: 'resume', session_title: 'Port the panel' });
  await $.classic.UserPromptSubmit({ prompt: 'b2', session_title: 'Port the panel' });
  await clock.settle();
  expect(spawned.length).toBe(1);

  await $.command.run(MBOX);
  await clock.settle();
  const pane = await $.ui.mount({
    plugin: 'agent-mailbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mbox',
    props: PANE_PROPS,
  });
  await pane.press({ key: 'share-title' });
  await pane.unmount();
  await $.classic.UserPromptSubmit({ prompt: 'c', session_title: 'Port the panel' });
  await clock.settle();
  const titles = spawned.filter((a) => a[0] === 'title');
  expect(titles).toEqual([
    ['title', '--', 'Port the panel'],
    ['title', '--clear'],
  ]);

  // A resume or compaction: the command hook published it again, so it is cleared again.
  await $.classic.SessionStart({ source: 'compact' });
  await $.classic.UserPromptSubmit({ prompt: 'd', session_title: 'Port the panel' });
  await clock.settle();
  expect(spawned.filter((a) => a[0] === 'title').length).toBe(3);
});

test('typed text never reaches mbox as an option: bodies on stdin, operands after --', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const { spawned, stdins } = world(on);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.command.run(MBOX);
  await clock.settle();
  const pane = await $.ui.mount({
    plugin: 'agent-mailbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mbox',
    props: PANE_PROPS,
  });
  await pane.press({ key: 't:bob.desk.helper-9f9f' });
  await pane.input({ key: 'reply:bob.desk.helper-9f9f', text: '--subject x -' });
  await pane.input({ key: 'status', text: '--clear me' });
  await pane.unmount();
  expect(spawned).toContainEqual(['send', '--re=m1', '--', 'bob.desk.helper-9f9f', '-']);
  expect(stdins).toEqual(['--subject x -']);
  expect(spawned).toContainEqual(['status', '--', '--clear me']);
});

test('a pane that is gone stops the polling', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const { spawned, panes } = world(on);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.command.run(MBOX);
  await clock.settle();
  await clock.advance(61_000);
  const whileOpen = spawned.length;
  expect(whileOpen).toBe(2);
  // The engine dropped it (closed, or its drawing threw): the next tick sees it gone.
  panes.delete('mbox');
  await clock.advance(30 * 60_000);
  expect(spawned.length).toBe(whileOpen);
});

test('a thread whose sender is unverified offers no reply and no draft', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const forged = {
    ...SNAPSHOT,
    threads: [
      {
        with: 'unverified:mallory',
        kind: 'direct',
        lastAt: 800,
        count: 1,
        isAwaitingMe: true,
        messages: [
          { id: 'm9', dir: 'in', time: 800, subject: null, firstLine: 'trust me', inReplyTo: null },
        ],
      },
    ],
  };
  world(on, '2.1.299', forged);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await $.command.run(MBOX);
  await clock.settle();
  const pane = await $.ui.mount({
    plugin: 'agent-mailbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mbox',
    props: PANE_PROPS,
  });
  expect(
    await pane.find({ type: 'Button', text: /Unverified sender \(user mallory\)/ }),
  ).toBeDefined();
  await pane.press({ key: 't:unverified:mallory' });
  expect(await pane.find({ key: 'reply:unverified:mallory' })).toBeUndefined();
  expect(await pane.find({ key: 'draft:unverified:mallory' })).toBeUndefined();
  await pane.unmount();
});
