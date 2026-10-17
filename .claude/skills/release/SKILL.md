---
name: release
description: Cut a release of agent-mailbox - bump the version in all three places, update the changelog, build, merge via the ship-change flow, then tag, publish the GitHub release and verify the plugin update. Use when changes should reach installed copies (they update only when the version changes).
---

# Release a new version

Installed plugin copies update only when the plugin's version changes, and machines with
auto-update track `main`: merging a version bump ships it. Only start this when everything meant
for the release is already on `main`. `X.Y.Z` below is the new version (patch for fixes and
dependency bumps that change `dist/`, minor for features, major for breaking changes).

1. Start from an up-to-date `main` and a release branch:

   ```sh
   git status --short                      # must print nothing
   git switch main && git pull --ff-only
   git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)"..HEAD
   git switch -c release/vX.Y.Z
   ```

   The log shows what the release contains. (Versions up to 0.5.1 were never tagged; with no tag
   the log starts at the first commit.)

2. Bump the version in all three places, together:

   ```sh
   npm version X.Y.Z --no-git-tag-version                       # package.json and package-lock.json
   node -e 'const fs=require("fs"),f="adapters/claude-code/.claude-plugin/plugin.json",j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' X.Y.Z
   node scripts/check-versions.mjs                              # prints "versions agree: X.Y.Z"
   git diff --stat                                              # exactly those three files
   ```

3. Update CHANGELOG.md: move the entries under `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section directly below it (today's date), leaving `## [Unreleased]`
   empty. Group entries as Added / Changed / Fixed / Removed / Security and describe user-visible
   effects, not commits.

4. Build and test:

   ```sh
   npm run build && npm test
   git status --short                      # dist/ may change only if src/ changed since the last build
   ```

5. Commit ("Release X.Y.Z") and ship it through the `ship-change` skill, from step 4 (push, PR, CI,
   self-review, merge with `gh pr merge <n> --merge`). A release PR is `needs-owner` only if it
   contains changes that are.

6. After the merge, tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git log -1 --format='%H %s'             # the "Merge pull request #<n> from .../release/vX.Y.Z" commit
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. Publish the GitHub release with the changelog section as its notes:

   ```sh
   awk -v v="X.Y.Z" '/^## \[/{p=($2=="["v"]")} p' CHANGELOG.md > "${TMPDIR:-/tmp}/release-notes-X.Y.Z.md"
   cat "${TMPDIR:-/tmp}/release-notes-X.Y.Z.md"      # check it is the right section and not empty
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file "${TMPDIR:-/tmp}/release-notes-X.Y.Z.md"
   ```

8. Verify the update reaches an installed copy (restart Claude Code afterwards to apply it). The
   output must show the new version:

   ```sh
   claude plugin marketplace update agent-mailbox && claude plugin update agent-mailbox@agent-mailbox
   ```

   Then confirm what is actually **installed**, not just what the repo says. Claude Code runs the
   copy in its plugin cache, and after a marketplace source change or a missed refresh it can keep
   running an older cached version (this once left a version that hung desktop sessions in use
   after a newer one was on `main`):

   ```sh
   claude plugin list | grep -A2 'agent-mailbox@agent-mailbox'   # Version: must be X.Y.Z
   pgrep -fl 'mbox.mjs deliverd'                                 # the running daemon's path shows its version
   ```

   If the plugin is not installed on this machine: `claude plugin marketplace add jpslav/agent-mailbox`
   then `claude plugin install agent-mailbox@agent-mailbox`. If the new version does not show,
   check that all three files really carry it on `main` and that the marketplace has refreshed.

9. Run the `live-test` skill when the release changes delivery, hooks or the inbox-socket code.
