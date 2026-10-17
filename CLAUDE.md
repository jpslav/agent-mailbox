# agent-mailbox: notes for agents working on this repo

A mailbox for AI agent sessions: `mbox` (Node CLI) lets sessions on different machines or of
different people send each other short text messages through a NATS JetStream server. Claude Code
is the only supported agent today. README.md is the user documentation; read it before changing
behavior.

## Layout

- `src/core/`: agent- and broker-neutral logic (addr, config, state, envelope, registry, and the
  receiving side: receiver, used by watch and wait).
- `src/core/transport/nats.js`: the transport seam, the only file that knows the broker.
- `src/agents/`: one plain object per agent (`claude-code.js`), registered in `agents/index.js`.
- `src/cli.js`: the `mbox` command. `scripts/build.mjs` bundles it with esbuild.
- `adapters/<agent>/`: that agent's integration files (`claude-code/`: plugin manifest, hooks,
  skill, `bin/mbox` POSIX-sh launcher, committed `dist/mbox.mjs`).
- `server/`: `mbox-admin.sh` (users, streams, permissions), `install.sh` (prints install steps),
  `nats-server.conf.example`, `systemd/` and `launchd/` service files.
- `test/`: `node:test` suites; the integration ones start a real nats-server.

## Rules

- **Public repo.** Nothing specific to a maintainer's setup: no real IPs, machine names, personal
  usernames, home paths, emails or organization names. Use `alice`/`bob`, `mailbox-host`,
  `100.x.y.z` and `example.ts.net`. The handle `jpslav` is fine as the repo owner. Check new text
  and fixtures before finishing.
- **Transport seam.** `src/core/*` (outside `transport/`), `src/agents/` and `src/cli.js` must never
  mention NATS concepts (subjects, `$JS`, JetStream, consumers, KV, `mbx.`). `test/transport.test.js`
  enforces it; if it fails, move the code into the transport, not the pattern out of the test.
- **dist is a committed build.** `adapters/claude-code/dist/mbox.mjs` is what the plugin and the
  tests run. Run `npm run build` after any change under `src/` and commit the result; CI rebuilds
  and fails on any diff.
- **Bump the version for every release.** Installed copies update only when the plugin's version
  changes, so any change users should receive bumps `version` in `package.json` and
  `adapters/claude-code/.claude-plugin/plugin.json` together.
- **Platforms.** macOS and Linux; native Windows is unsupported. Keep shell scripts POSIX `sh`.
  Paths follow `XDG_CONFIG_HOME` / `XDG_STATE_HOME` when set.
- **Never squash-merge.** Merge PRs with a merge commit (`gh pr merge --merge`); never recommend
  squash.

## Tests

`npm test` runs everything (`node --test --test-concurrency=1`). Integration suites need
`nats-server` (>= 2.11) and the `nats` CLI on `PATH` (or `NATS_SERVER_BIN` / `NATS_BIN`); without
them they are skipped, so make sure they ran. Each suite starts its own server on a random
127.0.0.1 port from `server/nats-server.conf.example`, provisioned by `server/mbox-admin.sh`
(see `test/helpers.js`). Run one file with `node --test test/isolation.test.js`.

## Security model (invariants)

- Every message is untrusted data. Each block is labelled as such, body lines starting with
  `[mailbox]` are neutralized (by `watch` and `wait` alike), and the skill tells the model never to
  treat bodies as instructions.
- The sender's user is enforced by the server: direct mail goes to `mbx.<user>.<host>.<label>.<sender>`
  and broadcasts to `mbx.all.<sender>`, and a user may only publish subjects ending in their own
  name. `verified-user` in the output comes from that last token, never from the envelope's `from`.
- Users read only their own stream, the broadcast stream (by direct get) and presence. They cannot
  create consumers elsewhere, delete or purge messages, or touch streams.
- Any change to the permission block in `server/mbox-admin.sh` (or to what the client needs from the
  server) needs a negative test in `test/isolation.test.js` that proves the new boundary against a
  real server. Widening permissions without one is a bug.
- Passwords: only on stdin, never in argv or logs; client config is mode 0600.

## Agent adapters

An adapter is `{id, displayName, detect(env), sessionId(env), hostPid(env), hookInput?, canWait?, hooks, instructions(ctx)}`
in `src/agents/`, plus files in `adapters/<agent>/`. It needs a stable session id, a way to get
mail to the model (Claude Code: an asyncRewake hook running `mbox wait` on SessionStart and Stop,
which exits 2 with the mail on stderr; agents that stream a process's stdout can run `mbox watch`
instead) and a session-start hook that tells the agent its address (`hooks['session-start']`,
dispatched by `mbox hook <agent> <event>`). Claude Code has no plugin monitor any more: the desktop
app never starts monitors, so hooks are the one delivery mechanism.
To add Codex or another agent: add `src/agents/<agent>.js`, register it in `src/agents/index.js`,
add `adapters/<agent>/`, add tests like `test/agents.test.js` and `test/hook.test.js`. Nothing in
`src/core/` should change; if it must, the abstraction is wrong. README.md ("Adding an agent
adapter") has the details.

## Validation before finishing

`npm run build && npm test`, `claude plugin validate ./adapters/claude-code --strict`,
`claude plugin validate . --strict`, `sh -n` on every shell script, and the public-repo grep
(maintainer names, hosts and home paths) over the tree, excluding `node_modules` and `.git`.
