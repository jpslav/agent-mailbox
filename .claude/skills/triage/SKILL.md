---
name: triage
description: Triage open issues and Dependabot pull requests in agent-mailbox - label, reproduce, decide. Use when asked to look after the issue tracker or dependency updates, or when a Dependabot PR or security alert appears.
---

# Triage issues and Dependabot PRs

## Issues

1. List what is open and read each one:

   ```sh
   gh issue list --state open --json number,title,labels,author,createdAt
   gh issue view <n> --comments
   ```

2. **Security first.** If an issue describes a vulnerability (permission bypass, spoofing,
   injection through message content, socket delivery, credential exposure), do not discuss
   details publicly: tell the repo owner, and treat the follow-up as `needs-owner`. The reporter
   should use private vulnerability reporting (SECURITY.md).
3. Label it (`bug`, `enhancement`, `question`, `documentation`; add `needs-owner` for anything in
   CLAUDE.md's needs-owner list):

   ```sh
   gh issue edit <n> --add-label bug
   ```

4. **Reproduce** a bug before deciding anything. Prefer a failing test: an integration test with
   the harness in `test/helpers.ts` (a real nats-server, run as in CLAUDE.md "Tests"). For
   delivery problems in real Claude Code sessions, use the `live-test` skill. Ask the reporter for
   `mbox doctor`, `mbox deliverd --status` and the Claude Code version if the report lacks them.
5. **Decide**, and say which in a comment on the issue:
   - fix it: follow `ship-change`, put `Fixes #<n>` in the PR body;
   - needs information: ask a specific question, label `question`;
   - not a bug / won't fix: explain why, referring to `docs/DECISIONS.md` when it applies, and
     close it;
   - a design or security-model change: label `needs-owner` and leave the decision to the owner.

## Dependabot pull requests

Dependabot opens weekly PRs for npm and GitHub Actions, with minor and patch updates grouped.

1. List them and their CI state:

   ```sh
   gh pr list --app dependabot --json number,title,headRefName
   gh pr checks <n>
   gh pr view <n>                            # the body quotes the release notes
   ```

2. **GitHub Actions updates** edit `.github/workflows/`, so they are `needs-owner`: label the PR and
   leave it for the owner. Check the diff first (`gh pr diff <n>`): the action must stay pinned to
   a full commit SHA with the version in a trailing comment, like
   `uses: actions/checkout@<40-hex sha> # vX.Y.Z`. If Dependabot changed the pin form, the PR is
   wrong.
3. **npm updates** (all dependencies are dev dependencies bundled into the committed `dist/`):

   ```sh
   gh pr checkout <n>
   npm ci && npm run typecheck && npm run lint && npm run build && npm test
   git status --short adapters/claude-code/dist
   ```

   - `dist/` changed (it usually does for the bundled `nats` packages and `commander`, and can for
     `esbuild`): this changes what users run, so it needs a **patch version bump** in
     `package.json`, `package-lock.json` and `plugin.json` together (the `release` skill, step 2),
     a CHANGELOG entry, and the rebuilt `dist/` committed on the PR branch. CI rejects the PR
     otherwise ("dist is up to date" or the version check).
   - `dist/` did not change: no bump needed (the tooling devDependencies: TypeScript, tsx, ESLint,
     Prettier, the git hook tools).
   - Dependencies are pinned to exact versions: keep it that way when updating `package.json`
     (no `^` or `~`), and take a version published at least two weeks ago
     (`npm view <pkg> time --json`). `typescript-eslint` supports only some TypeScript versions
     and several tools have Node engine floors (CI runs Node 20 and 22): read the peer
     dependencies before accepting a major bump of any of them.
   - Read the upstream changelog before accepting a major version, and for anything in the
     `@nats-io` packages (the transport seam, `src/core/transport/nats.ts`, is the only consumer).
   - A bump that changes how authentication or permissions behave is `needs-owner`.
4. Merge when CI is green and the rules above are met: `gh pr merge <n> --merge`. Never squash.
   Close PRs you decide against with a comment; Dependabot stops re-opening ignored versions only
   if told (`@dependabot ignore this major version`).
5. **Security alerts and updates.** List open alerts and handle them promptly:

   ```sh
   gh api repos/{owner}/{repo}/dependabot/alerts --jq '.[] | select(.state=="open") | [.number, .security_advisory.severity, .dependency.package.name, .security_advisory.summary] | @tsv'
   ```

   A fix that needs a bump follows step 3. Tell the owner about any high or critical alert.
