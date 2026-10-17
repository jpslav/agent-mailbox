# Contributing

Thanks for helping with agent-mailbox. Bug reports, feature ideas and pull requests are welcome.
Coding agents maintain this repository too; their instructions are in [CLAUDE.md](CLAUDE.md),
which is also the most complete description of how the project is run.

## Reporting problems

- Bugs and feature requests: open an issue using the templates.
- Security problems: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 18 or newer, plus `nats-server` (2.11 or newer) and the `nats` CLI on `PATH` for
the integration tests (they are skipped without them, so check that they ran).

```sh
npm ci
npm run build   # bundles src/ into adapters/claude-code/dist/mbox.mjs (commit the result)
npm test
```

`adapters/claude-code/dist/mbox.mjs` is a committed build. Run `npm run build` after changing
anything under `src/` and commit the result; CI rebuilds it and fails on any difference.

## Pull requests

1. Branch from an up-to-date `main`; never push to `main` directly (it is protected).
2. Keep a PR to one logical change, with descriptive commit messages in plain style.
3. Add or adjust tests. Tests must pass on a slow, loaded machine: no timing-based assertions.
4. If your change should reach users, bump the version in `package.json`, `package-lock.json` and
   `adapters/claude-code/.claude-plugin/plugin.json` together. Installed copies update only when
   the version changes. CI checks that the three agree, and that a change to `dist/` comes with a
   new version.
5. Fill in the PR template. Changes to server permissions, authentication or credential handling,
   the delivery protocol, the runaway guard, CI workflows or anything touching the security model
   are labelled `needs-owner` and need the repo owner's explicit approval.
6. CI (four jobs: Ubuntu and macOS on Node 20 and 22) must pass and the branch must be up to
   date. PRs are merged with a merge commit; squash and rebase are disabled.

Keep the repository generic: no real hostnames, IP addresses, personal usernames, home paths,
emails or organization names. Use `alice`/`bob`, `mailbox-host`, `100.x.y.z` and `example.ts.net`.

## Where things are documented

- [README.md](README.md): user documentation and architecture.
- [CLAUDE.md](CLAUDE.md): the maintainer's handbook (rules, workflow, security invariants).
- [docs/DECISIONS.md](docs/DECISIONS.md): why the design is the way it is.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the inbox-socket and NATS wire details.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
