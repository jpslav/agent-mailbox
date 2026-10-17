# Decision log

One entry per decision that a future maintainer might be tempted to reverse. Add new entries at
the end; do not rewrite old ones (supersede them with a new entry that says so). Format: date,
context, decision, why.

## NATS JetStream, not ntfy

- **Date:** 2026-10
- **Context:** The first idea for the broker was ntfy.
- **Decision:** Use a single NATS server with JetStream.
- **Why:** ntfy's server is Linux-only (the macOS builds are client-only, so a Mac host needed
  Docker). JetStream gives durable consumers with acknowledgements, a KV store for presence, file
  storage, and clustering if it is ever needed. It runs natively on macOS and Linux.

## Per-user streams, plus a broadcast stream read by direct get

- **Date:** 2026-10
- **Context:** Users must not read each other's mail, and broadcasts must reach everyone.
- **Decision:** One stream `MBX_<USER>` per user, one shared `MBX_ALL` for broadcasts. Sessions
  read broadcasts with direct gets from their last seen sequence; a core subscription on
  `mbx.all.*` is only a wake-up.
- **Why:** NATS permissions can isolate by stream, but cannot prefix-restrict consumer names, so
  a shared stream would let any user create or read consumers belonging to others. Direct get
  needs no consumer, so nobody needs consumer rights on the shared stream.

## The sender's user is verified server-side; the session is not

- **Date:** 2026-10
- **Context:** Mail from other people's sessions is untrusted, but recipients still need to know
  who sent it.
- **Decision:** Direct mail goes to `mbx.<user>.<host>.<label>.<sender>` and broadcasts to
  `mbx.all.<sender>`. A user may only publish subjects whose last token is their own name. The
  output's `verified-user` comes from that token, never from the envelope's `from`.
- **Why:** The server enforces it, so it cannot be forged by a client. Which of a user's sessions
  sent a message (host and label) is self-asserted and stays that way: the server has no notion
  of sessions.

## Retention of 180 days, with a stale flag after 24 hours

- **Date:** 2026-10
- **Context:** Sessions can be offline for days; mail should wait for them, but old instructions
  are dangerous to act on.
- **Decision:** Streams keep mail for 180 days (1 GiB cap, discard old). A message sent more than
  24 hours before delivery is shown with "may be stale".
- **Why:** Long retention lets a resumed session catch up; the stale flag tells the model (and
  the user) not to treat day-old mail as current.

## Delivery: the per-session inbox socket, fed by one daemon

- **Date:** 2026-10
- **Context:** An idle session must wake up when mail arrives, in the terminal and in the desktop
  app. Four mechanisms were tried in order.
- **Decision:** Use the documented per-session inbox socket, fed by one auto-started
  `mbox deliverd` per user and machine. `mbox wait` stays as the generic fallback.
- **Why, and what was rejected:**
  - _Plugin monitors_ were rejected: the desktop app does not start them.
  - _asyncRewake hooks_ were rejected: the desktop app treats a session with a running hook as
    busy and queues the user's input behind it, which hung a session.
  - _A background-task `mbox wait`_ works, but shows a running task in every session, which can
    block managers from archiving child sessions. It stays as the generic fallback for agents
    without a push channel.
  - _The inbox socket_ runs nothing inside any session, wakes idle sessions in both apps, and is
    documented by Claude Code for scripts and hooks. See PROTOCOL.md.

## Honest sender

- **Date:** 2026-10
- **Context:** Claude Code's own cross-session messages carry relay-chain, hop and permission-mode
  fields, and cap relay loops. The mailbox could have copied them.
- **Decision:** Socket posts carry a `from-name` only, never chain, hop, session or permission-mode
  fields. The mailbox has its own runaway guard instead: a per-session rate limit
  (`AGENT_MAILBOX_MAX_PER_MIN`, default 30) and `mbox pause` / `mbox resume`.
- **Why:** Asserting fields the mailbox is not (a permission mode, a relay chain) would be
  claiming trust it has not earned. In the live test, 40-round ping-pongs ran without being cut by
  Claude Code's relay-loop cap, so the cap is not what protects against runaway loops here; the
  mailbox's own guard is.

## Agent-neutral core with adapters and a transport seam

- **Date:** 2026-10
- **Context:** Claude Code is the only supported agent today, and NATS is the only broker.
- **Decision:** `src/core/` knows neither a specific agent nor the broker. Agents are plain
  adapter objects in `src/agents/`; the broker lives behind one interface in
  `src/core/transport/nats.ts`. `test/transport.test.ts` enforces the seam.
- **Why:** Adding Codex or another agent should not touch core, and the broker should be
  replaceable. If an addition forces a core change, the abstraction is wrong.

## Merge commits only, never squash

- **Date:** 2026-10
- **Context:** How PRs land on `main`.
- **Decision:** Merge with a merge commit (`gh pr merge --merge`). Squash and rebase are disabled
  in the repository settings and by the `protect-main` ruleset.
- **Why:** A squash flattens the reviewed commit history, and with it the record of who decided
  what and in which order.

## Tests must hold under load

- **Date:** 2026-10
- **Context:** The first CI run failed on all four jobs. Most failures were timing assumptions
  that slower runners broke; running the suite with every core busy then exposed two real bugs
  (truncated large output because `process.exit()` ran before a full pipe was written, and a
  message delivered twice when the server redelivered it while the daemon was still posting it).
- **Decision:** Timing-based assertions are not allowed. Tests assert on totals and order, pause
  the component they are inspecting, or wait for a condition; timeouts are generous. Run the
  suite under load (every core busy) when touching delivery code.
- **Why:** CI runners are slow, and loaded runs found two bugs that quiet runs hid.

## Strict TypeScript, golden tests for the wire formats

- **Date:** 2026-10
- **Context:** The code base was plain JavaScript, and its contracts (the adapter interface, the
  transport seam, envelope v1, registrations, presence entries) lived in comments. Several
  machines and a closed-source agent depend on the exact bytes it writes.
- **Decision:** `src/` and `test/` are strict TypeScript (`strict`, `noUncheckedIndexedAccess`,
  NodeNext); the contracts are exported interfaces in `src/core/types.ts` and
  `src/agents/adapter.ts`. esbuild still bundles (`tsc --noEmit` only checks) and the tests run
  through `tsx`, so the committed `dist/mbox.mjs` stays the only artifact. `test/golden.test.ts`
  and `test/golden-presence.test.ts` assert the exact JSON of the envelope, a registration file, a
  presence entry and the inbox-socket line; they were written against the JavaScript first and
  passed before and after the conversion. ESLint (type-checked), Prettier and git hooks keep it
  that way; CI runs the three checks as steps of the existing `test` job.
- **Why:** The compiler now checks the seam and the adapter contract, and untrusted data (hook
  payloads, files, presence entries) must be narrowed before use. Golden tests make a wire-format
  change a deliberate, reviewed act instead of a side effect.

## A newer delivery daemon takes over from an older one

- **Date:** 2026-10
- **Context:** `mbox deliverd` is one long-lived daemon per user and machine. It outlives plugin
  updates: after an auto-update, new sessions run the new hooks while the old daemon keeps
  delivering with the old code, possibly forever if some session is always open. A machine ran a
  daemon from before the 0.5.1 duplicate-delivery fix this way.
- **Decision:** The bundle knows its version (`scripts/build.mjs` injects it from
  `package.json`), and the daemon writes its version and bundle path into `deliverd.lock`. The
  session-start hook compares versions as semantic versions (numerically; a lock without a
  version, from before 0.5.3, counts as older than any): a newer hook asks the old daemon to hand
  over (SIGTERM) and starts the new daemon detached, so the hook never waits; the same or an older
  version does nothing (never a downgrade), whatever path it runs from. The new daemon waits for
  the old one's lock and kills it (SIGKILL, logged) if it has not exited after 20 s; the old one
  stops taking messages, finishes the delivery in flight and its acknowledgement, hands back
  everything else unacknowledged, oldest first and without delay, releases the lock and exits.
  A start claim (`deliverd.starting`) keeps sessions that start together from starting several
  daemons, and the lock settles any race left.
- **Why:** SIGTERM is the signal every earlier version already treats as a graceful stop, so the
  rule takes over daemons that know nothing about it, including one whose bundle was deleted with
  an old plugin cache. Durable positions are per session, not per daemon, so the new daemon's
  receivers pick up exactly what the old one handed back, first; delivered ids are on disk before
  they are acknowledged, so nothing is shown twice. The 20 s bound covers a delivery in flight (an
  inbox post gives up after 10 s) plus its acknowledgement. Limits: a pre-0.5.3 daemon stops within
  a few seconds whatever is in flight and hands mail back with a delay, so taking one over keeps
  every message but may show one that was in flight that long a second time, or out of order. And a message
  the server hands the old daemon in the instant it stops listening comes back only after the
  60 s redelivery interval.

## No CPU-load testing on maintainers' machines; fault injection instead

- **Date:** 2026-10
- **Context:** "Tests must hold under load" (above) had maintainers run the suite with every core
  busy. That found real bugs, but it pegged the repo owner's working machine for minutes at a
  time, repeatedly.
- **Decision:** Supersedes the "run the suite under load" part of that entry. Never load a
  maintainer's machine. Races are tested by forcing the ordering with test-only fault-injection
  knobs (`AGENT_MAILBOX_FAULT=...`), and the suite runs on Node 22 as well as the newest Node.
  CI's slow runners provide the real-load signal; if more is ever needed, add a separate,
  non-required stress workflow on CI runners.
- **Why:** Deterministic fault injection reproduces a race every time, where load only makes it
  likely, and it costs nobody their machine. The two-week rule for new dependency versions is
  likewise enforced by Dependabot's `cooldown` (14 days) rather than by memory.
