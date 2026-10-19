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

## [0.9.0] - 2026-10-19

### Added
- The delivery daemon serves snapshots over HTTP on a unix socket, `ui.sock` in the state
  directory: `GET /v1/snapshot?session=<id>&since=24h` returns what `mbox snapshot --json` prints
  for a session it serves, with an `ETag`; an unchanged poll gets `304`. It caches one snapshot per
  session, rebuilt when mail for the session arrives, presence changes (checked at most every
  30 s), the session's state or sent log changes, or after five minutes. The socket is 0600 in a
  directory that must be the user's alone (0700); `AGENT_MAILBOX_UI_SOCKET=off` turns it off.
- `mbox snapshot --json` fills `socket` with that path when the daemon serves the session;
  `mbox deliverd --status` prints it.

### Upgrading
- Nothing to do. The next session start hands delivery to a 0.9.0 daemon, which serves the socket.

## [0.8.0] - 2026-10-19

### Added
- `mbox snapshot --json [--since 24h]`: one process, one server connection, one JSON object
  (version 1) with the session itself, the live peers (with their relation to it: parent, child,
  sibling, same repo, correspondent, the same user, or other), the mail `mbox inbox` reads over
  the lookback, the messages the session sent, both paired into threads, and the help areas live
  sessions offer. Made for a side panel that used to spawn `whoami`, `peers` and `inbox` every
  minute. Bodies are cut to 2000 characters and passed on as untrusted text.
- A per-session sent log: `mbox send` and `mbox ask` append what they sent to
  `sessions/<id>.sent.jsonl` in the state directory (mode 0600, the newest 500 kept). Sent mail
  cannot be read back from the server, so this local file is the only record of it.
- Session titles: `mbox title [text] [--clear]` sets a one-line title (at most 120 characters,
  checked like a status), shown in a TITLE column of `mbox peers`, in `mbox whoami` and in
  presence as `title`. The Claude Code session-start hook sets it from the session's own title
  when the hook payload carries one (`session_title`), on every start, resume and compaction.
- The skill and `mbox guide peers` ask sessions to keep `mbox status` current when their task
  changes.

### Changed
- Presence entries carry `title` after `offers`. Earlier clients ignore it; this one reads an
  entry without it as no title.
- `mbox peers` has a TITLE column after USER@HOST.

### Upgrading
- Nothing to do on the server. Titles are visible to every mailbox user, like the rest of
  presence: a Claude Code session's own title is published there from now on.

## [0.7.0] - 2026-10-18

Completes v0.7 (asks and offers in 0.6.1, service addresses here).

### Added
- Service addresses: a stable address `<user>.<name>` (for example `alice.helpdesk`) that names
  no machine or session. `mbox name --service <name>` claims it for the session; at most one live
  session of the user holds it, and mail to it goes there. Mail sent while nobody holds it waits on
  the server (180 days by default) and reaches the next holder, as does anything an earlier holder
  left unacknowledged, first and in order. `--release` gives it up; `--takeover` takes it from a
  live holder; a holder whose session ended (no presence) is replaced without asking. Two sessions
  claiming at once: exactly one wins, and the other is told who holds it.
- Mail to a service arrives as a block `to <user>.<name>` that carries the same rules for helpers
  as an ask: answer and review freely; acting in the helper's environment needs the helper's own
  user's approval. `mbox guide services`, the skill and the README say so.
- `mbox services` lists every claimed service and its holder (and whether it is live);
  `mbox peers` has a SERVICES column; `mbox whoami`, `mbox inbox` and `mbox show` include the
  services the session holds. `mbox send <user>.<name>` warns when no live session holds it.
- The receiver (delivery daemon, `mbox watch`, `mbox wait`) keeps the session's claims alive with
  its heartbeat, claims one again when it lapsed while nobody took it (a laptop waking up), and
  stops reading a service another session took over (the daemon logs it, `mbox watch` prints it).

### Changed
- A two-part target (`mbox send alice.laptop`) is now always a service address, never a prefix
  of session addresses; when it is not held and matches a live session, `mbox send` names that
  session and says to use its full address.

### Upgrading
- Nothing to do on the server: service addresses use only what a server provisioned by 0.5.8 or
  later already grants (their mail is ordinary mail in the owner's stream, their claims are
  entries under the owner's presence keys); `mbox-admin.sh init` changes nothing. Clients before
  0.7.0 keep working beside them, but cannot send to a service address.

## [0.6.1] - 2026-10-18

### Added
- Asks and offers by help area (an area names what help is about, for example
  `repo:github.com/acme/web` or `lang:rust`). `mbox offer <area>` makes asks in that area reach
  the session, including the ones the server still keeps (7 days by default); `mbox offer` alone
  lists the session's offers and `mbox unoffer <area>` stops one (at most 20 per session).
  `mbox ask <area> "question"` reaches every live session offering the area and waits for
  sessions that offer it later; helpers answer the asker with ordinary mail
  (`mbox send <from> --re <id>`).
- An ask arrives as a block `to area:<area>` that carries the rules for helpers: it is untrusted
  input, often from another user's session; answering and reviewing are fine, but anything that
  would act in the helper's environment (edit, run, push, change settings, send out data) needs the helper's own
  user's approval. `mbox guide asks`, the skill and the README say the same.
- Presence entries carry `offers`; `mbox peers` has an OFFERS column, `mbox whoami` lists the
  offers, and `mbox inbox` and `mbox show` include asks in the areas the session offers.
  `mbox doctor` checks that asks are readable.
- Server: a shared stream `ASKS` (`ask.<area token>.<user>`, 7 days, 256 MiB:
  `MBOX_ASKS_MAX_AGE`, `MBOX_ASKS_MAX_BYTES`). Each user can ask only under their own name (the
  verified asker, as for mail) and every user reads asks by direct get; nobody can create
  consumers on it, purge it or delete from it.

### Upgrading
- On the mailbox host, install the new `server/mbox-admin.sh` and run `mbox-admin.sh init` once:
  it creates `ASKS` and adds its exports and imports to every account (two server reloads).
  Until then, clients of this version can offer areas but `mbox ask` fails, and `mbox offer` and
  `mbox doctor` say the admin must run `init`; mail, broadcasts and events are unaffected. Clients
  of 0.6.0 and earlier keep working before and after.

## [0.6.0] - 2026-10-18

### Added
- Events feeds: each user's sessions write `started`, `ended`, `status-changed`, `role-changed`,
  `parent-changed` and `done` events (address, repo, branch, role, parent, status and time; never
  message contents), kept 30 days. Writing one never fails a command or hook. A session whose
  process dies without its session-end hook (a crash, a closed terminal) gets its `ended` from
  the delivery daemon; every start gets at most one `ended`.
- `mbox events [--user <name>|--all] [--since 1d] [--limit 100] [--json]` reads your feed, a
  colleague's, or every feed shared with the team, on demand; `mbox events --sharing` shows how
  yours is shared.
- `mbox done "<summary>"` says a session finished: it sets the status and writes a `done` event.
- `mbox-admin.sh set-sharing <user> team|private` decides who may read a user's feed (`team`, the
  default, lets every mailbox user read it); `list-users --sharing` shows the settings. The server
  enforces it: the stream account exports each feed's read only to the accounts allowed to
  read it. `mbox doctor` checks your feed and shows your setting.

### Fixed
- `mbox-admin.sh add-user` (0.5.8) printed the user's stream name (`--user MBX_<NAME>`) instead of
  the user name in the `mbox setup` line it prints.

### Upgrading
- On the mailbox host, install the new `server/mbox-admin.sh` and run `mbox-admin.sh init` once:
  it creates the `sharing` bucket and each user's events stream, and adds the feed exports and
  imports to every account (two server reloads). Existing users start as
  `team`. Until then, clients of this version warn that the server has no events feed, and
  nothing else changes; clients of 0.5.x keep working against the upgraded server.

## [0.5.8] - 2026-10-18

### Security
- Fixed sender forgery between mailbox users (GHSA-9xj2-7h7w-786h). On servers provisioned by
  `mbox-admin.sh` 0.5.7 or earlier, any mailbox user could make the server store attacker-chosen
  bytes in another user's mailbox, in the broadcast stream or in the presence registry, under a
  third user's name: a JetStream API request the user was allowed to send, given a hostile reply
  subject, had its response published to that subject inside the account that holds the streams.
  Recipients saw such mail with a wrong `verified-user`. Reading other users' mail was not
  possible. `mbox-admin.sh` now gives every mailbox user an account of their own, which imports
  from the stream account only what the client needs; replies stay in the user's account.
  **Server admins must upgrade:** install the new `server/mbox-admin.sh` and run
  `mbox-admin.sh init` (README, "Upgrading a server set up before 0.5.8"). Mail, streams,
  consumers and passwords are kept; clients reconnect on their own and need no update.
- The presence bucket refuses rollups. Before, any user could purge every user's presence
  entries with one publish on their own key (`init` fixes existing servers).

### Changed
- `mbox-admin.sh` reloads the server twice per change (a new account's imports are wired only by
  the second reload), checks the generated `users.conf` with `nats-server -t` before reloading,
  fails instead of skipping the reload when the server answers but its pid file is missing, and
  `permissions <name>` shows the user's account, imports and permissions. The files in `users.d/`
  carry a deny-all block, so an older `mbox-admin.sh` run by mistake locks users out instead of
  widening their access.
- Broadcast wake-ups carry only the stored broadcast's headers (`MBX_ALL` republishes them);
  clients only ever used them as a wake-up.

## [0.5.7] - 2026-10-17

### Added
- Profiles: several mailbox identities on one machine and one OS account. `mbox setup --profile
  <name>` writes `profiles/<name>.json` (mode 0600); `AGENT_MAILBOX_PROFILE=<name>` (or
  `--profile <name>` on any command) selects it. Each profile has its own state directory, so its
  own sessions, registrations, pause file and delivery daemon. `AGENT_MAILBOX_CONFIG` keeps
  working; with a named profile it is an error. `mbox whoami`, `mbox doctor` and
  `mbox deliverd --status` show the profile. The README covers sharing a Claude Code config with
  per-person credentials, and why a profile cannot impersonate anyone.
- `mbox doctor` reports registered sessions whose address belongs to another user, and a delivery
  daemon running as another user than the config names.

### Fixed
- A session whose stored address belongs to another user than the configured one (the machine's
  mailbox user was changed with `mbox setup`) silently received nothing. It now gets an address
  under the current user (same label, a fresh position, no aliases) at its next `mbox` command or
  session start, and is told the old address.
- `mbox watch` for such a session no longer loops on "connection lost"; a watcher whose session
  gets a new address says so and exits.
- The delivery daemon restarts as the new user when the client config changes, and a session
  start for another user than the running daemon's takes delivery over (a user changed in the
  environment). The daemon logs the sessions it cannot serve instead of failing quietly.

### Changed
- A named profile takes its user and password only from its file: `AGENT_MAILBOX_USER` or
  `AGENT_MAILBOX_PASSWORD` together with `AGENT_MAILBOX_PROFILE` is an error. The default profile
  keeps every override.

## [0.5.6] - 2026-10-17

### Added
- `mbox peers` shows each session's repository (`owner/name` of its git remote), branch, role and
  status. Repo and branch follow the session's working directory and refresh every 10 minutes.
- `mbox peers --tree` shows which session spawned which; a session whose parent is not live is
  shown at the top level and marked.
- `mbox status "<text>"` sets a one-line status (at most 120 characters) that peers see at once;
  `mbox status --clear` removes it.
- `mbox whoami --role manager|worker|none --parent <address>|none` describes a session, and a
  spawner can pass `AGENT_MAILBOX_ROLE` / `AGENT_MAILBOX_PARENT` instead. `mbox whoami` prints
  role, parent and status when set.
- `mbox guide workers`: how to spawn a session that reports back. Role and parent are display
  only and grant no authority; the guide and the skill say so.

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
