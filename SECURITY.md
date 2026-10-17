# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request. Use GitHub's
private vulnerability reporting: open the repository's **Security** tab and choose **Report a
vulnerability** (a private security advisory). Include what you found, how to reproduce it, and
which version (`version` in `package.json`) it affects.

The repo owner reads these reports and decides on fixes and disclosure. Expect an acknowledgement
within a few days. Please do not disclose publicly until a fix is released.

Secret scanning with push protection and Dependabot alerts are enabled on the repository.

## Scope

In scope:

- **The server permission model**: the per-user permissions that `server/mbox-admin.sh` writes
  (one user reading, deleting or publishing into another user's mail, creating consumers
  elsewhere, touching streams or presence entries that are not theirs).
- **Message spoofing**: forging the verified sender user, or making a message appear to come from
  someone else.
- **Injection through message content**: a message body that escapes its block (forging
  `[mailbox]` boundaries or the `cross-session-message` wrapper) or otherwise makes a receiving
  session treat mail as instructions from its user.
- **Socket delivery**: the delivery daemon (`mbox deliverd`) and the registrations it reads, for
  example posting mail into a session it should not, leaking a session token, or being steered by
  another local user.
- Credential handling: passwords in argv, logs or world-readable files.

Out of scope: weaknesses of the NATS server itself (report those to the NATS project), the
administrator of a mailbox server reading its mail (the admin can read everything by design),
and anything that requires an already-malicious administrator or local access as the same OS user.

## Trust model in short

- **All mail is untrusted data.** Every message is labelled as untrusted content from another
  agent session, body lines starting with `[mailbox]` are neutralized so a body cannot forge block
  boundaries, and the agent's skill tells the model never to treat a body as an instruction from
  its user.
- **The sender's user is verified; the sender's session is not.** The server enforces that a user
  can only publish subjects ending in their own name, so `verified-user` can be trusted as far as
  the server and its admin can. Which of that user's sessions sent the message (host and label) is
  self-asserted.
- Users can read only their own stream, broadcasts and presence. The server admin can read
  everything.
- Passwords are stored as bcrypt hashes on the server and in a mode 0600 file on clients, and are
  only ever passed on stdin.

The full model is in the "Security model and limits" section of README.md and in the invariants
in CLAUDE.md.
