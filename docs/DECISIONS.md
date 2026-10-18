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

## Delivery order across readers

- **Date:** 2026-10
- **Context:** Agents hold conversations over the mailbox, and a session that sees "3" before "2"
  can get confused. Within one reader, mail arrived in stream order, but not across readers: the
  takeover tests failed under load because messages handed back by the old daemon (or lost in the
  instant it stopped, or held by a killed one) came back after newer mail. Handing back in order
  is not enough either: the server does not always redeliver nak'd messages in nak order.
- **Decision:** Direct mail reaches a session in stream order (for one sender, send order), across
  readers too. A subscription that starts while the session's consumer still has unacknowledged
  messages (`num_ack_pending`) holds everything it receives until every one of them (each
  sequence up to `delivered.stream_seq`) is back, then offers all of it sorted by stream sequence.
  The hold gives up after `ack_wait` plus max(5 s, half of `ack_wait`) and offers what it has.
  Broadcasts stay ordered among themselves only. Messages carry no sequence number for the model.
  Takeover log lines are not ordered across processes; tests assert order only between lines one
  process writes. This supersedes the "out of order" limit in "A newer delivery daemon takes over
  from an older one": a pre-0.5.3 daemon's late hand-back and the stop gap now delay newer mail
  instead of reordering it.
- **Why:** It is the strongest guarantee that keeps batching. `max_ack_pending` 1 would order
  everything but deliver one message per socket post and break the runaway guard's count of held
  mail. The hold costs nothing while a session has one reader; after a clean handover the owed
  messages return at once; only a crash or the stop gap delays newer mail, by up to about
  `ack_wait` (60 s), which beats showing it first. A per-sender or stream sequence in the message
  block would change what the model sees, would not reveal reordering reliably (stream
  sequences have gaps from other sessions' mail), and is unnecessary once order holds.
- **Limit:** a message that does not come back within the hold (a server redelivering late) is
  shown after newer mail. A previous reader that acknowledges a message after the next one started
  only makes the hold run to its end.

## Session metadata in presence: read from git's files, display only

- **Date:** 2026-10
- **Context:** People and manager sessions need to see who each session is and what it is doing
  across machines: its repository and branch, whether it is a manager or a worker, which session
  spawned it, and a status line (#15).
- **Decision:** Presence entries carry `repo`, `branch`, `role`, `parent` and `status`. Repo and
  branch are read from git's own files (`.git`, `HEAD`, `commondir`, `config`) on every
  heartbeat, never by running `git`. Role and parent come from `AGENT_MAILBOX_ROLE` /
  `AGENT_MAILBOX_PARENT` (taken when the session's state is created, so a resume or a compaction
  never undoes a later change) or `mbox whoami --role/--parent`; status
  from `mbox status`. They live in the session's state file; a receiver re-reads it before every
  heartbeat, so no heartbeat puts back values a command just replaced. All five are
  self-asserted and display only; readers keep only well-formed values.
- **Why:** The delivery daemon refreshes every session it serves every 10 minutes; spawning `git`
  there would cost a process per session per heartbeat and would run whatever the repository
  configures (an fsmonitor hook, for example) inside the daemon. A parent claim proves nothing
  (any session can name any address), so it must never become a reason to trust mail: the guide
  and the skill say so explicitly. Unknown or malformed values become `null` rather than errors,
  so an odd entry cannot break `mbox peers` for everyone.
- **Limits:** only the repository's own `config` is read (no `include`, `includeIf` or `insteadOf`),
  so such setups may show no repo or the un-rewritten one. The reads are synchronous, so a working
  directory on a stalled network mount would hold up the daemon's heartbeats for a while; local
  checkouts are the normal case.

## Live test: full length only where length matters

- **Date:** 2026-10
- **Context:** The live test's 40-round volley was built to show that Claude Code's relay-loop cap
  does not cut a long exchange and that the mailbox's rate limit is the real guard ("Honest
  sender"). It takes 3 to 4 minutes of two watched sessions, and was being run for every change
  that touched hooks or presence too.
- **Decision:** The `live-test` skill has two lengths: full (to 40) after any change to delivery,
  the inbox socket, the delivery daemon, the rate limit or pause/resume, and after a new Claude
  Code version; short (to 6) for any other change real sessions must show, plus whatever checks
  that change needs.
- **Why:** A short volley proves what those changes can break (sessions wake, receive and reply);
  only the full one tests the relay-loop cap and the rate limit, which only the first group of
  changes can affect.

## Profiles: one identity per config file, with its own state and daemon

- **Date:** 2026-10
- **Context:** Several people may use one machine and one OS account, for example with a shared
  Claude Code config, and each must appear as themselves (#17). The client had one config file
  and one state directory, so one daemon served everyone as one user.
- **Decision:** A profile is a config file `profiles/<name>.json` next to `config.json` (the
  default profile), written by `mbox setup --profile <name>` and selected with
  `AGENT_MAILBOX_PROFILE` or `--profile` (which sets the variable, so the hooks, the Bash tool and
  the daemon a command starts all inherit it). A named profile's state lives in
  `<state dir>/profiles/<name>/`: sessions, registrations, the pause file and the delivery daemon's
  lock, so each profile runs its own daemon as its own user. `AGENT_MAILBOX_CONFIG` keeps working
  with the default state directory; together with a named profile it is an error, and an invalid
  profile name is an error, never a fall-back to the default profile.
- **Why:** Identity stays where the server checks it, the password: a profile name grants nothing,
  and `verified-user` still comes from the server. Per-profile state means nothing a session of one
  profile writes (an address, a cursor, a registration) is read with another profile's
  credentials. Keeping the variable as the one source lets processes the agent starts on its own
  agree on the profile without passing flags.
- **Limits:** profiles of one OS account are all readable by that account. They separate identities
  of people who share a machine, not people who must be kept from acting as each other; those need
  separate OS accounts. `mbox pause --all` holds one profile's sessions, not every profile's.

## A session whose stored address belongs to another user gets a new one

- **Date:** 2026-10
- **Context:** `ensureSession` kept a session's address forever. After `mbox setup` changed the
  machine's user, a resumed session kept `<old user>.<host>.<label>`, which the new credentials
  cannot read: it silently received nothing, and `mbox watch` looped on "connection lost". The
  running daemon also kept its old credentials and could not serve sessions of the new user.
- **Decision:** `ensureSession` gives such a session `<current user>.<host>.<same label>`, a fresh
  cursor (a cursor is a position in one user's stream; it now records the address it was made
  for, and one for another user, or one without an address after such a change, is not used) and
  no aliases (an alias must belong to the same user); the command says so on stderr and the
  session-start hook in the session's instructions. A receiver whose session gets a new address
  under it stops writing its cursor and stops (`mbox watch` says so and exits). A receiver never
  starts for an address of another user (a clear error, not a reconnect loop). The daemon records
  its user in its lock, does not serve sessions of another user (one log line each; `mbox deliverd
--status` and `mbox doctor` name them), and when the client config names another identity it
  stops and starts a daemon that reads the new config. A session start whose configuration names
  another user than the running daemon of the same version takes delivery over from it (the usual
  handover; never a downgrade), which covers a user changed in the environment. A named profile
  refuses `AGENT_MAILBOX_USER` / `AGENT_MAILBOX_PASSWORD`, so its identity is its file's.
- **Why:** The old address cannot work with the new credentials, so keeping it only hides the
  failure. Re-addressing on the next command or session start is the least surprising repair; mail
  to the old address stays on the server for the old user. The daemon restarting itself (rather
  than waiting for a version takeover or its idle exit) is what lets a machine's sessions under the
  new user get mail without anyone killing a process.

## Per-user accounts

- **Date:** 2026-10
- **Context:** Supersedes the mechanism of "The sender's user is verified server-side; the session
  is not" (the guarantee is unchanged). Every user shared one NATS account with the streams, and
  publish permissions restricted what they could send. NATS has no permission on reply subjects:
  a user could send an allowed JetStream API request, for example a direct get of a forged
  envelope stored in their own stream, with a reply subject like `mbx.bob.h.l.carol`, and the
  server published the response there, inside the shared account, where `MBX_BOB` stored it as
  mail from carol. The same reached `MBX_ALL` and the presence bucket. `allow_responses` is for
  responders and does not help; no permission block can fix it.
- **Decision:** The account `MAILBOX` keeps JetStream, every stream and the admin, unchanged, so an
  upgrade moves no mail, stream or consumer. Each mailbox user gets an account of their own,
  `USER_<name>`, without JetStream, which imports from `MAILBOX` exactly the services the client
  needs: publishing on subjects that end in the user's own name (`mbx.*.*.*.<u>`, `mbx.all.<u>`,
  `$KV.presence.<u>.>`), the API calls on their own stream (stream info, durable consumer create
  and info, `MSG.NEXT` with streamed responses, acks, direct get) and the shared read-only ones
  (account info, `MBX_ALL` info and direct get, presence direct gets). `MAILBOX` exports each
  service only to the accounts that may import it. The permission block stays inside each user
  account as defense in depth; the tests prove the boundary without it. `mbox-admin.sh init`
  upgrades a server provisioned by an earlier script in place (password hashes kept, the old files
  saved for a rollback, idempotent and safe to re-run). Subjects, streams and the client are
  unchanged: clients already deployed keep working.
- **Broadcast wake-ups:** NATS never passes a message that arrived through a service import on to
  a stream export, so exporting `mbx.all.*` as a stream wakes nobody. Instead `MBX_ALL`
  republishes the headers of each stored broadcast to `mbxwake.all.<sender>` (no body), exported
  as a stream and imported by every user account as `mbx.all.<sender>`, the subject clients
  already subscribe to. The wake-up's content was never used; now it is only the stored message's
  headers.
- **Why:** With accounts, any reply to a user's request is delivered inside that user's own account,
  where no stream can capture it. A hostile reply subject reaches the stream account only through
  that account's imports, as mail the user could already send under their own name, or as an API
  call they could already make. Per-user accounts are the NATS mechanism for exactly this
  isolation. Signing envelopes could let readers reject forgeries, but it changes the wire
  format, needs key distribution, and still lets anyone write into others' streams and the
  presence bucket. Push consumers a user may create on
  their own stream deliver inside `MAILBOX`, only to listeners there (none in production), and a
  delivery keeps its stored subject, so it stays in the user's own name (tested).
- **Safety around the change:** the `users.d` files carry a deny-all permission block that the
  script ignores, so an older `mbox-admin.sh` run by mistake afterwards (it copies those files
  into the stream account) locks users out instead of giving them the whole account. The
  presence bucket now refuses rollups, which let any user purge everyone's entries.
- **Limits:** The stream account's account info (`mbox doctor`) still shows totals for the whole
  server, as before. A user's own streams remain readable by the admin.

## A new account's imports need a second reload

- **Date:** 2026-10
- **Context:** With nats-server 2.15.1, a configuration reload that adds an account (a new user, or
  every user during the upgrade to per-user accounts) authenticates that account's user but does
  not wire its imports: requests get no responders. The next reload wires them. Existing accounts
  are unaffected, and it is not timing: waiting does not help, a second reload always does.
- **Decision:** `mbox-admin.sh` always sends the reload signal twice (with `MBOX_RELOAD_SETTLE`
  between), and `add-user` checks, logged in as the new user, that the account answers through its
  imports, reloading again a few times at most before giving up. `test/upgrade.test.ts` pins the
  behaviour: it fails if one reload ever becomes enough (then the second can go) or if two are no
  longer enough. Nothing has been filed upstream yet.
- **Why:** A restart would also work but drops every connection and makes the script depend on how
  the server is supervised. A redundant reload is cheap: connections stay up.
