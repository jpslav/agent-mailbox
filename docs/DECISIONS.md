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
