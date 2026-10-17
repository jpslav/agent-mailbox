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
