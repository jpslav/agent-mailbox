# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). The plugin version (`package.json`,
`package-lock.json` and `adapters/claude-code/.claude-plugin/plugin.json`, always equal) is what
makes installed copies update, so every user-visible change ships with a version bump.

Versions 0.1.0 and 0.2.0 were early development before the repository's first commit; they are
listed for completeness and are reconstructed from nothing but the first commit's contents, so
treat them as approximate.

## [Unreleased]

## [0.5.5] - 2026-10-17

### Fixed
- Direct mail now reaches a session in send order across a delivery-daemon handover, a daemon
  that was killed or restarted, and reconnects. Mail the previous reader held unacknowledged
  could come back after newer mail (seen as "3" before "2"); a reader that starts while earlier
  mail is still out now holds newer mail until that is back, then delivers all of it in order.
  After a clean handover there is no visible delay; after a crash, newer mail can wait up to
  about a minute. Stopping such a reader still takes effect at once. Broadcasts stay in order
  among themselves, not relative to direct mail.

## [0.5.4] - 2026-10-17

### Fixed
- `mbox wait` now notices a newer waiter or a starting `mbox watch` from the moment it takes its
  lock, also while it is still opening its receiver (the cursor lookup and presence announcement),
  and then leaves without ever subscribing. Before, a slow broker or machine could keep that
  waiter running past the watcher's 10 s patience, so both could receive for the session. Closes
  the flaky `wait` test of issue #12.
- Stopping a receiver while its subscription is still connecting or setting up now takes effect
  at once; before, a stop that arrived during the connect went unnoticed and waited up to 15 s.
  A `mbox wait` that steps aside now always exits within a few seconds, whatever stage its
  receiver is in.

## [0.5.3] - 2026-10-17

### Added
- Version takeover for the delivery daemon. A running `mbox deliverd` used to keep delivering with
  its old code after a plugin update, for as long as any session stayed open. It now records its
  version and bundle path in its lock file, and a session start running a newer version takes
  delivery over: it asks the old daemon to hand over and starts the new one without waiting
  (the hook stays well under a second). The old daemon stops taking mail, finishes the delivery
  in flight, hands everything else back to the server in order and exits; the new one delivers
  it, each message once. A daemon that does not exit within 20 s is killed (logged). The same
  version from another install path, or an older version, leaves the running daemon alone, and
  sessions starting together start one daemon. Daemons from before 0.5.3 are taken over too
  (they stop on SIGTERM), but without the in-order handover: nothing is lost, yet a delivery in
  flight for several seconds at that moment may be shown twice, and mail they held may arrive
  late or out of order.
- `mbox deliverd --status` shows the daemon's version and bundle path (and whether this `mbox` is
  newer); `mbox --version` prints the version.

### Changed
- A receiver that stops (`mbox wait`, `mbox watch`, the daemon) now hands unacknowledged mail back
  at once and oldest first, instead of after a delay or the 60 s redelivery interval, so the
  session's next reader gets it in order.
- Dependabot no longer proposes commander 13 and later: commander 15 needs Node >= 22.12, and
  the runtime target is Node >= 18.

### Fixed
- The daemon's lock file is created complete or not at all, and a stale lock is removed only if it
  is still the stale one, so two daemons starting together are far less likely to both take it.

## [0.5.2] - 2026-10-17

### Added
- Maintainer kit: CLAUDE.md rewritten as a maintainer's handbook, project skills under
  `.claude/skills/` (`ship-change`, `release`, `live-test`, `triage`, `add-adapter`),
  `docs/DECISIONS.md`, `docs/PROTOCOL.md`, SECURITY.md, CONTRIBUTING.md, issue and pull request
  templates, CODEOWNERS, Dependabot configuration and a project `.claude/settings.json` allowlist.
- CI checks (steps in the existing `test` job): the three version fields must agree, and a pull
  request that changes `adapters/claude-code/dist/` must change the version.

### Changed
- Source converted to TypeScript; no behavior change.

### Fixed
- `server/mbox-admin.sh init` (and `add-user`) could lose a freshly created stream when the server
  finished applying a reload afterwards. `init` now reloads only when `users.conf` really changed,
  waits for the reload to settle, re-checks the stream and presence bucket and recreates what is
  missing.

## [0.5.1] - 2026-10-17

### Fixed
- Large output was truncated: `process.exit()` ran before Node had written a big stdout or stderr
  write into a full pipe (macOS pipes start at 16 KB), so `mbox show` and long batches were cut
  off. The CLI now flushes stdio before exiting.
- A message could be delivered twice: if the server redelivered it while the daemon was still
  posting it, the daemon treated the copy as new. In-flight ids now count as already seen.
- CI: the test suite now holds on slow runners (batching and rate-limit tests no longer assert on
  window timing, the hook context-length check excludes the checkout-dependent launcher path, the
  broker harness no longer loses freshly created streams to a stray reload, and slow-runner
  timeouts were loosened).

## [0.5.0] - 2026-10-17

### Changed
- Delivery uses the per-session inbox socket that Claude Code documents for scripts posting into a
  session. The SessionStart hook registers the session's socket and auto-starts `mbox deliverd`,
  one daemon per user and machine, which holds the mailbox connection and posts each message into
  the right session. An idle session starts a new turn by itself, and nothing runs inside any
  session. This replaces the asyncRewake waiter, which hung desktop sessions.
- Delivery is an adapter capability: the Claude adapter speaks the inbox-socket protocol, and
  other agents use `mbox wait` / `mbox watch`.
- Posts come from an honest external sender: a `from-name`, but no chain, session or
  permission-mode fields.
- `mbox wait` refuses to block only in hook mode under the desktop app, so it still works as a
  background task there.

### Added
- A runaway guard: a per-session rate limit (`AGENT_MAILBOX_MAX_PER_MIN`, default 30) and
  `mbox pause` / `mbox resume`.
- `mbox guide [section]` gives agents concise help.
- `mbox deliverd --status`.

## [0.4.0] - 2026-10-16

### Changed
- Delivery uses Claude Code's asyncRewake hooks instead of a plugin monitor, because the desktop
  app runs plugin hooks but never starts plugin monitors. On SessionStart and at every Stop, a
  background `mbox wait` blocks until mail arrives, writes it to stderr and exits 2, which wakes
  the session. The monitor is removed.
- One waiter per session: a newer waiter supersedes the older one, and a running `mbox watch`
  takes precedence over both. Acks happen only after the stderr write, so delivery stays
  at-least-once.
- `mbox wait` exits at once under `claude -p`, where asyncRewake hooks run in the foreground.

### Added
- A SessionEnd hook stops the waiter and removes the session from presence, including on `/clear`.
- `mbox show <id>`; batches are capped at 8,000 characters.
- A fallback in the hook text and skill: when `mbox` is unavailable, use the built-in
  SendMessage for your own sessions.
- CLAUDE.md requires a version bump per release, since installed copies only update on version
  changes.

## [0.3.0] - 2026-10-15

First commit in the repository.

### Added
- `mbox`, a CLI for agent sessions on different machines, or belonging to different people, to
  message each other through a NATS JetStream server. Claude Code is the first supported agent,
  through a plugin whose monitor pushes each incoming message into the session as a notification.
- Agent- and broker-neutral core; all NATS code sits behind one transport seam, and adapters plug
  in per agent.
- One stream per user, with server-side publish permissions enforcing the sender's user and
  negative tests against a real nats-server proving the isolation.
- At-least-once delivery with explicit acks and de-duplication; file-backed storage with 180-day
  retention; presence in a KV bucket with a TTL.
- Server scripts (`server/mbox-admin.sh`, `server/install.sh`) and service files for macOS
  (launchd) and Linux (systemd); CI on Ubuntu and macOS.

## [0.2.0] - date unknown

Development before the first commit; no separate record. Contents are folded into 0.3.0.

## [0.1.0] - date unknown

Development before the first commit; no separate record. Contents are folded into 0.3.0.
