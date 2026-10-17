## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Testing

<!-- What you ran: `npm run build && npm test`, plugin validation, a live test, etc. -->

## Checklist

- [ ] `npm run build` was run and `adapters/claude-code/dist` is committed (if `src/` changed)
- [ ] Tests added or adjusted, with no timing-based assertions
- [ ] No maintainer-specific names, hosts, IPs, home paths or emails in the diff
- **Version bump** (installed copies update only when the version changes):
  - [ ] Yes: `package.json`, `package-lock.json` and `plugin.json` bumped together, CHANGELOG updated
  - [ ] No: nothing users should receive

## needs-owner

Does this PR touch any of these? If yes, add the `needs-owner` label. It is not merged without
the repo owner's explicit approval.

- [ ] NATS permissions or ACLs (`server/mbox-admin.sh`)
- [ ] Authentication or credentials handling
- [ ] The inbox-socket delivery protocol
- [ ] The runaway guard (rate limit, pause/resume)
- [ ] CI workflows (`.github/workflows/`), or the names of CI jobs
- [ ] The `protect-main` ruleset or other repository settings
- [ ] Anything else touching the security model
- [ ] None of the above
