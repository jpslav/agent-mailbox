---
name: ship-change
description: Take a change from a branch to a merged pull request in agent-mailbox. Use for every change to this repo, however small (never push to main or squash-merge); also covers waiting for CI, self-review and the needs-owner decision.
---

# Ship a change: branch to merged PR

`main` is protected: changes land only through a pull request with the four CI checks green and
the branch up to date, merged with a merge commit. Replace `<n>` with the PR number and `<branch>`
with your branch name throughout.

1. Start from an up-to-date `main` with a clean tree, and create the branch:

   ```sh
   git status --short                      # must print nothing
   git switch main && git pull --ff-only
   git switch -c <type>/<topic>            # e.g. fix/ack-race, docs/protocol-notes
   ```

2. Make the change. Before committing, run the checks that apply (all of them for code changes):

   ```sh
   npm run typecheck                       # tsc, strict
   npm run lint                            # ESLint (type-checked rules)
   npm run format:check                    # Prettier; `npm run format` fixes it
   npm run build && npm test               # build commits dist/; integration suites must RUN, not skip
   node scripts/check-versions.mjs
   claude plugin validate ./adapters/claude-code --strict
   claude plugin validate . --strict
   for f in adapters/claude-code/bin/mbox server/*.sh; do sh -n "$f"; done
   ```

   The git hooks cover part of this: pre-commit runs Prettier and ESLint on the staged files,
   pre-push runs `npm run typecheck` and `npm run test:unit`. They are a safety net, not a
   substitute: run the full list above before pushing, because CI runs `format:check`, `lint` and
   `typecheck` as steps of every `test` job. If a hook blocks you for a reason that is not about
   your change, fix that rather than bypassing it; `--no-verify` or `SKIP_SIMPLE_GIT_HOOKS=1` is
   for emergencies only (CLAUDE.md, "Formatting, linting and git hooks").

   Re-read CLAUDE.md "Rules" and "Security model" if the change touches those areas. Keep names,
   hosts and paths generic (public repo). A change that users should receive also needs the
   version bump (see the `release` skill).

3. Commit in logical steps, with descriptive plain messages (no Conventional Commits prefixes: a
   short imperative subject, then a body saying what and why). Include the rebuilt `dist/` in the
   same commit as the `src/` change that caused it.

   ```sh
   git add <paths>
   git commit
   ```

4. Push and open the PR. Write the body from `.github/pull_request_template.md` (summary, testing,
   checklist, version bump yes/no, needs-owner). Add `--label needs-owner` if step 7 says so.

   ```sh
   git push -u origin HEAD
   gh pr create --title "<subject>" --body-file <body.md>
   ```

5. Wait for CI. `--watch` returns when the checks finish and exits non-zero on a failure
   (exit 1 failed, exit 8 pending or not finished); `--fail-fast` stops at the first failure. No
   hand-rolled polling loops.

   ```sh
   gh pr checks <n> --watch --fail-fast
   gh pr checks <n>                         # confirm: all four "test (...)" jobs say pass
   ```

   - On a failure, read the log (`gh run view <run-id> --log-failed`), fix on the same branch,
     push, and wait again. A failure that only shows on a slow runner is a real bug (see
     CLAUDE.md, "Tests must hold on slow machines"): fix the test or the code, never add a sleep.
   - If the PR says it is behind `main` ("branch must be up to date"), merge `main` in and wait
     again: `gh pr update-branch <n>` (a merge commit, not a rebase).
   - No checks appearing at all usually means a merge conflict with `main`; resolve it.

6. Self-review the whole diff as a reviewer would, not just the last commit:

   ```sh
   gh pr diff <n>
   gh pr view <n> --comments
   ```

   Check: the change does what the PR says and nothing else; tests prove it (and would fail
   without it); no maintainer-specific names, hosts or paths; docs, CHANGELOG and the skills are
   still true; every review thread is resolved. For a non-trivial change, also run a review
   (the `code-review` or `branch-review` skill, or a fresh subagent given only the diff) and fix
   what it finds; then wait for CI again.

7. Decide `needs-owner`. The PR is `needs-owner` if it touches NATS permissions or ACLs
   (`server/mbox-admin.sh`), authentication or credentials handling, the inbox-socket delivery
   protocol, the runaway guard, CI workflows or job names, the `protect-main` ruleset, or anything
   else in the security model (CLAUDE.md lists them). If it does:

   ```sh
   gh pr edit <n> --add-label needs-owner
   ```

   State in the PR what the owner must decide, then **stop**. Do not merge until the owner has
   explicitly approved, in the PR or in chat. A green CI run is not approval. Never use an admin
   bypass to merge past failing or missing checks.

8. Merge with a merge commit. Never squash, never rebase, never push to `main`:

   ```sh
   gh pr merge <n> --merge
   ```

   The remote branch is deleted on merge. Tidy up locally:

   ```sh
   git switch main && git pull --ff-only && git branch -d <branch>
   ```

9. If the change should reach users, it is not shipped until it is released: follow the `release`
   skill.
