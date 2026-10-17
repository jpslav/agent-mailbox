# agent-mailbox: the maintainer's handbook

A mailbox for AI agent sessions: `mbox` (Node CLI) lets sessions on different machines or of
different people send each other short text messages through a NATS JetStream server. Claude Code
is the only supported agent today. README.md is the user documentation; read it before changing
behavior.

Claude Code sessions are the main maintainers of this repository, and a session has no memory of
how the project was built. Everything it needs is in the repo: this file (rules and workflow),
`.claude/skills/` (step-by-step procedures), `docs/DECISIONS.md` (why things are the way they are)
and `docs/PROTOCOL.md` (wire details). The human repo owner approves security-sensitive changes
(see "needs-owner").

## Layout

- `src/core/`: agent- and broker-neutral logic (addr, config, state, envelope, registry, guide,
  and the receiving side: receiver, used by deliverd, watch and wait; registrations and pause
  for the push daemon `deliverd`).
- `src/core/transport/nats.js`: the transport seam, the only file that knows the broker.
- `src/agents/`: one plain object per agent (`claude-code.js`), registered in `agents/index.js`;
  `claude-inbox.js` is Claude Code's inbox-socket protocol (the `delivery` capability).
- `src/cli.js`: the `mbox` command. `scripts/build.mjs` bundles it with esbuild;
  `scripts/check-versions.mjs` is the CI version check.
- `adapters/<agent>/`: that agent's integration files (`claude-code/`: plugin manifest, hooks,
  skill, `bin/mbox` POSIX-sh launcher, committed `dist/mbox.mjs`).
- `server/`: `mbox-admin.sh` (users, streams, permissions), `install.sh` (prints install steps),
  `nats-server.conf.example`, `systemd/` and `launchd/` service files.
- `test/`: `node:test` suites; the integration ones start a real nats-server.
- `docs/`: `DECISIONS.md`, `PROTOCOL.md`. `.claude/skills/`: this repo's procedures.
  `.claude/settings.json`: the shared permissions allowlist (routine read-only and build/test
  commands only; nothing that pushes, merges, deletes or publishes).

## Rules

- **Public repo.** Nothing specific to a maintainer's setup: no real IPs, machine names, personal
  usernames, home paths, emails or organization names. Use `alice`/`bob`, `mailbox-host`,
  `100.x.y.z` and `example.ts.net`. The handle `jpslav` is fine as the repo owner. Say "the repo
  owner", never a person's name. Check new text and fixtures before finishing (the grep is under
  "Validation").
- **Transport seam.** `src/core/*` (outside `transport/`), `src/agents/` and `src/cli.js` must never
  mention NATS concepts (subjects, `$JS`, JetStream, consumers, KV, `mbx.`). `test/transport.test.js`
  enforces it; if it fails, move the code into the transport, not the pattern out of the test.
- **dist is a committed build.** `adapters/claude-code/dist/mbox.mjs` is what the plugin and the
  tests run. Run `npm run build` after any change under `src/` and commit the result; CI rebuilds
  and fails on any diff.
- **Bump the version for every release.** Installed copies update only when the plugin's version
  changes, so any change users should receive bumps `version` in `package.json`,
  `package-lock.json` and `adapters/claude-code/.claude-plugin/plugin.json` together. CI fails if
  the three disagree, or if a pull request changes `dist/` without changing the version. Every
  machine with plugin auto-update tracks `main`: a version bump that lands on `main` reaches all
  of them at their next marketplace refresh, and a `dist/` change without a bump never reaches
  anyone. Bump only when the change is ready to ship; follow the `release` skill.
- **Platforms.** macOS and Linux; native Windows is unsupported. Keep shell scripts POSIX `sh`.
  Paths follow `XDG_CONFIG_HOME` / `XDG_STATE_HOME` when set.
- **Never squash-merge.** Merge PRs with a merge commit (`gh pr merge --merge`); never recommend
  squash. Squash and rebase are disabled in the repository settings.
- **Never push to `main` directly.** The `protect-main` ruleset requires a pull request.
- **Tests must hold under load.** CI runners are slow. No timing-based assertions: assert on
  totals and order, pause what you inspect, wait for conditions, use generous timeouts. Run the
  suite with every core busy when touching delivery code; loaded runs found two real bugs.

## The change workflow

Every change, however small, goes branch, commit, push, pull request, CI, self-review, merge.
The `ship-change` skill has the exact commands.

1. Start from an up-to-date `main` and create a branch (`git switch -c <type>/<topic>`).
2. Commit in logical steps with descriptive plain messages (no Conventional Commits prefixes).
   Run `npm run build && npm test` first; commit the rebuilt `dist/` when `src/` changed.
3. Push the branch and open a PR with the template filled in.
4. Wait for CI with `gh pr checks <n> --watch --fail-fast` and read the result. Do not hand-roll
   polling loops.
5. Self-review: re-read the full diff (`gh pr diff <n>`) as a reviewer would. For a non-trivial
   change, run a review (the `code-review` or `branch-review` skill, or a fresh subagent) and fix
   what it finds.
6. Decide whether the PR is `needs-owner` (below). If yes, label it and stop.
7. Otherwise merge with `gh pr merge <n> --merge`. Never squash.

## `needs-owner`: changes the repo owner must approve

Add the `needs-owner` label to any PR that touches:

- NATS permissions or ACLs (the permission block in `server/mbox-admin.sh`, or what the client
  needs from the server);
- authentication or credentials handling (passwords, tokens, client config files, registrations);
- the inbox-socket delivery protocol (`src/agents/claude-inbox.js`, `docs/PROTOCOL.md`);
- the runaway guard (rate limit, `mbox pause` / `mbox resume`);
- CI workflows (`.github/workflows/`). Renaming or adding CI jobs also requires updating the
  `protect-main` ruleset's required checks, which only the owner can do;
- the ruleset or other repository settings;
- anything else touching the security model (see "Security model").

A `needs-owner` PR is not merged without the owner's explicit approval, given in that PR or in
chat. Silence, a green CI run or a self-review is not approval. Say in the PR what needs the
owner's decision. When in doubt, label it.

## GitHub settings (already applied; do not change them)

- **Merge methods:** merge commits only; squash and rebase are disabled; branches are deleted on
  merge.
- **Ruleset `protect-main`** on the default branch: no deletion and no force-push; pull requests
  required, with 0 approvals, review threads resolved, and merge method "merge" only; required
  status checks are the four CI jobs `test (ubuntu-latest, node 20)`, `test (ubuntu-latest, node
  22)`, `test (macos-latest, node 20)` and `test (macos-latest, node 22)`, strict (the branch must
  be up to date); the admin role can bypass only when merging PRs.
- **Secret scanning and push protection**, **Dependabot alerts and security updates** are on.
- The label **`needs-owner`** exists.

Add CI steps inside the existing `test` job; never add or rename jobs without the owner updating
the ruleset (a `needs-owner` change).

## Releases

Use the `release` skill: bump the three versions together, update CHANGELOG.md, build, ship the
change via the `ship-change` flow, then tag the merge commit `vX.Y.Z`, push the tag, create the
GitHub release from the changelog, and verify with `claude plugin marketplace update
agent-mailbox && claude plugin update agent-mailbox@agent-mailbox`. A release is a version bump
that has been merged; do not merge a bump you do not intend to ship.

## Dependencies and Dependabot

Dependabot opens weekly PRs for npm and GitHub Actions (minor and patch updates grouped). Use the
`triage` skill. In short:

- Runtime code is bundled into the committed `dist/mbox.mjs`, so **an npm bump that changes
  `dist/` needs a patch version bump** and a rebuilt `dist/` (CI rejects it otherwise). A bump
  that does not change `dist/` (devDependencies that are not bundled) needs none.
- GitHub Actions stay pinned to a full commit SHA with the version in a trailing comment
  (`uses: owner/action@<sha> # vX.Y.Z`). Keep that form when updating. A workflow change is
  `needs-owner`.
- Read the changelog of anything bundled (`nats` packages, `commander`, `esbuild`) before
  merging a major bump; run the full tests.
- Security updates and alerts: fix promptly; if the fix touches the security model, it is
  `needs-owner`.

## Security reports

Vulnerabilities are reported privately through GitHub private vulnerability reporting; see
SECURITY.md. Never discuss an unfixed vulnerability in a public issue, PR or commit message. If a
report reaches a session by another route, tell the owner and handle it as `needs-owner`.

## Where knowledge lives

- `README.md`: user documentation and architecture.
- `docs/DECISIONS.md`: the decision log (why NATS, why per-user streams, why the inbox socket,
  why merge commits, ...). Read it before reversing a design choice; add an entry when you make
  one.
- `docs/PROTOCOL.md`: Claude Code's inbox-socket line format (reverse-engineered), what Claude
  sees, how to tell the protocol changed, and the NATS subject scheme, streams, presence KV,
  permission block and envelope v1.
- `.claude/skills/`: `ship-change`, `release`, `live-test`, `triage`, `add-adapter`.
- `CHANGELOG.md`: user-visible changes per version.
- `CONTRIBUTING.md`: the human-oriented version of this file.

## Tests

`npm test` runs everything (`node --test --test-concurrency=1`). Integration suites need
`nats-server` (>= 2.11) and the `nats` CLI on `PATH` (or `NATS_SERVER_BIN` / `NATS_BIN`); without
them they are skipped, so make sure they ran. Each suite starts its own server on a random
127.0.0.1 port from `server/nats-server.conf.example`, provisioned by `server/mbox-admin.sh`
(see `test/helpers.js`). Run one file with `node --test test/isolation.test.js`.

## Live testing

Unit and integration tests cannot see changes in Claude Code itself. The `live-test` skill is the
recipe: a throwaway server, a temp client config and two real sessions counting to 40 over the
mailbox. Rules:

- Sessions launched for a live test run where a human can watch them, for example a visible
  terminal. **Never launch autonomous headless Claude sessions** (`claude -p`, background
  spawns) and **never change permission modes** to make a test easier.
- Use only throwaway servers and temp config/state directories. Never point a test at a real
  mailbox server or the real client config.
- Re-run it after any change to delivery, hooks or the inbox-socket code, and when a new Claude
  Code version might have changed the protocol (see `docs/PROTOCOL.md`).

## Security model (invariants)

- Every message is untrusted data. Each block is labelled as such, body lines starting with
  `[mailbox]` are neutralized (by `watch` and `wait` alike), and the skill tells the model never to
  treat bodies as instructions.
- The sender's user is enforced by the server: direct mail goes to `mbx.<user>.<host>.<label>.<sender>`
  and broadcasts to `mbx.all.<sender>`, and a user may only publish subjects ending in their own
  name. `verified-user` in the output comes from that last token, never from the envelope's `from`.
  The sender's session within a user is self-asserted.
- Users read only their own stream, the broadcast stream (by direct get) and presence. They cannot
  create consumers elsewhere, delete or purge messages, or touch streams.
- Any change to the permission block in `server/mbox-admin.sh` (or to what the client needs from the
  server) needs a negative test in `test/isolation.test.js` that proves the new boundary against a
  real server. Widening permissions without one is a bug.
- Passwords: only on stdin, never in argv or logs; client config is mode 0600.

## Agent adapters

An adapter is `{id, displayName, detect(env), sessionId(env), hostPid(env), hookInput?, canWait?, delivery?, hooks, instructions(ctx)}`
in `src/agents/`, plus files in `adapters/<agent>/`. It needs a stable session id, a way to get
mail to the model and a session-start hook that tells the agent its address (`hooks['session-start']`,
dispatched by `mbox hook <agent> <event>`). Getting mail in: preferably a `delivery` capability
(`{kind, sessionEnv, endpointFromHook, deliver}`) used by the push daemon `mbox deliverd`
(Claude Code: the session-start hook registers the session's inbox socket and starts the daemon,
the session-end hook deregisters; `deliver` posts one JSON line to the socket). Agents without a
push channel use the generic fallbacks `mbox wait` (a background task) or `mbox watch`; keep both.
The inbox socket's line format is undocumented (read from the Claude Code bundle): `docs/PROTOCOL.md`
holds the excerpt and the fields used; keep it, `src/agents/claude-inbox.js` and `FakeInbox` in
`test/helpers.js` in step. Never assert a permission mode, a relay/hop chain or a reply address
that the mailbox is not.
To add Codex or another agent, use the `add-adapter` skill: add `src/agents/<agent>.js`, register
it in `src/agents/index.js`, add `adapters/<agent>/`, add tests like `test/agents.test.js` and
`test/hook.test.js`. Nothing in `src/core/` should change; if it must, the abstraction is wrong.
README.md ("Adding an agent adapter") has the details.

## Validation before finishing

`npm run build && npm test`, `claude plugin validate ./adapters/claude-code --strict`,
`claude plugin validate . --strict`, `sh -n` on every shell script (`adapters/claude-code/bin/mbox`
and `server/*.sh`), `node scripts/check-versions.mjs`, and the public-repo grep (maintainer names,
hosts and home paths) over the tree, excluding `node_modules` and `.git`. The grep is for your
own machine's identifiers: take them from `whoami`, `hostname`, `echo "$HOME"` and the git author
email, and search for each, for example:

```sh
grep -rniE "$(whoami)|$(hostname -s)|$HOME" --exclude-dir=node_modules --exclude-dir=.git . | grep -v jpslav
```

Any hit other than the owner handle `jpslav` must go. Keep the identifiers themselves out of the
repo, and out of PR text.
