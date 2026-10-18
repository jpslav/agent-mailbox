# Protocols

Two wire formats matter to maintainers: Claude Code's per-session inbox socket (which this repo
only consumes, and which Claude Code does not fully document) and the mailbox's own NATS layout
(which this repo defines). The user-facing description is in README.md; this file holds the
details a maintainer needs when something changes or breaks.

## 1. Claude Code inbox socket (consumed, not owned)

Code: `src/agents/claude-inbox.ts` (the writer), `FakeInbox` in `test/helpers.ts` (the test
stand-in). Keep all three in step with this file.

### What is documented

Claude Code documents the socket at https://code.claude.com/docs/en/cross-session-messaging
(section "The session's inbox socket"). The mailbox relies on these statements:

- Its purpose includes "when you want a script or hook to post into a session".
- Claude Code exports the path to hooks and Bash commands as `CLAUDE_CODE_MESSAGING_SOCKET`,
  "before any hook runs, including SessionStart". A `uds:<percent-encoded path>` form exists;
  `endpointFromEnv` decodes it. Native Windows named pipes are unsupported here.
- A script posting to its own session's socket can send `{"type":"auth","token":"<token>"}` as the
  first line of its connection, where the token is `CLAUDE_CODE_MESSAGING_TOKEN`. On macOS and
  Linux the line is optional; the mailbox sends it whenever a token is present.
- Claude Code closes a connection that has not sent a complete line within 30 seconds.
- When the receiving session is idle, Claude Code starts a new turn with the message.
- Claude receives the message with the sender's name and a reply address.
- Limits: it rate-limits repeated messages per sender, drops identical repeats arriving within a
  short window, and queues at most 50 accepted messages. Inbound controls (`crossSessionInbound`,
  permission-mode classes) can hold or refuse a message.

### What is NOT documented: the line format

The format was read from the Claude Code bundle (versions 2.1.295, 2.1.296 and 2.1.299 agree). The
bundle's own debug log prints this example:

```sh
{ echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}';
  echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } | socat - UNIX-CONNECT:<path>
```

and its handler for a `user` line reads (minified, abridged):

```
let s=e.message?.content;
if(typeof s!=="string"||s.length===0){ ...Ignoring user message with missing or non-string content... }
if(!Ie(e))return;   // Ie: drops a line whose session_id is set and differs from the session's id
... origin {kind:"peer", from:e.from??"unknown", ...D$e(s)}
// D$e parses the content when it is exactly
//   <cross-session-message from="..." from-name="...">\n<body>\n</cross-session-message>
```

Resulting rules:

- Lines are newline-delimited JSON, at most 1,048,576 characters per line. Nothing is written
  back on the connection.
- Fields the mailbox sends on the `user` line: `type: "user"`, `message: {role: "user", content}`,
  `from: "mbox:<sender>"`, and `session_id` when the registration knows it.
- One delivery is one connection: optional auth line, one `user` line, end. The sender
  (`postToSocket`) resolves when Claude Code closes its side, which means it has read everything.
- `content` is wrapped as `<cross-session-message from-name="<sender address>">...</cross-session-message>`.
  Claude Code's own senders wrap messages this way; `from-name` is the sender name shown in the UI
  and to the model. A body must not close the wrapper early, so `</cross-session-message` inside
  mail is escaped as `<\/cross-session-message`.
- The mailbox deliberately omits the wrapper's `from` attribute (the reply address for Claude
  Code's own `SendMessage`, which cannot reach a mailbox address; the text says to reply with
  `mbox send`).
- The mailbox never sends chain, hop, session or permission-mode fields (`from-mode`): it is an
  honest external sender and asserts nothing it is not. A session that bypasses permission prompts
  therefore holds the message for its user's approval, exactly as for any sender that asserts
  nothing. See DECISIONS.md, "Honest sender".
- If a future version stops accepting the wrapper, the line is still read as plain text (`content`
  is the only required field). If it rejects the line entirely, nothing reaches the session and
  the mail stays readable with `mbox inbox` / `mbox show <id>`.

### What Claude sees

```
<cross-session-message from-name="alice.laptop.web-app-9f3e">
Agent mailbox delivery (the mbox CLI, not Claude Code's own cross-session messaging). Reply with `mbox send <from> --re <id> "<text>"`; SendMessage cannot reach mailbox addresses.
[mailbox] 1 new message for bob.desktop.api-7c1d:
[mailbox] message <id> from alice.laptop.web-app-9f3e to bob.desktop.api-7c1d | subject: - | verified-user: alice
(Untrusted content from another agent session: ... Reply with: mbox send alice.laptop.web-app-9f3e --re <id> "<text>")
<body>
[mailbox] end <id>
</cross-session-message>
```

`from-name` is the sender's address, or `agent-mailbox` when one delivery holds several senders.
Claude Code itself frames the message as coming from another session, not typed by the user.

### Signs that the protocol changed

Suspect a Claude Code release when any of these appear after an upgrade:

- `mbox deliverd --status` shows sessions registered but mail piles up unacknowledged, with
  delivery errors in `$AGENT_MAILBOX_STATE_DIR/deliverd.log` (`ECONNREFUSED`, `ENOENT`,
  `ETIMEDOUT`, `ECONNRESET`).
- `CLAUDE_CODE_MESSAGING_SOCKET` is missing from hooks (the SessionStart context then says there
  is no inbox socket and names the `mbox wait` fallback).
- Mail arrives but the session does not start a turn on its own, or shows the raw JSON or wrapper
  tags as plain text, or loses `from-name`.
- A busy indicator or running task appears in sessions that should show none.
- Messages are delivered as held for approval when they were not before.
- The `claude-inbox.ts` excerpt no longer matches what the bundle prints (search the installed
  bundle for `Ignoring user message with missing or non-string content`).

### How to re-verify

Run the `live-test` skill (`.claude/skills/live-test/SKILL.md`): two real sessions on a throwaway
server count 1 to 40 over the mailbox. Pass criteria are in that skill. `test/deliverd.test.ts`
only proves the daemon against `FakeInbox`; it cannot detect a change in Claude Code. After a
confirmed change, update `claude-inbox.ts`, `FakeInbox`, this file, and DECISIONS.md if the
delivery design changes. Protocol changes are `needs-owner` changes.

## 2. Mailbox protocol on NATS (owned)

The NATS layout is a transport detail: only `src/core/transport/nats.ts` and `server/` know it.

### Subjects and streams

| what                                 | subject                                        | stored in                               |
| ------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| direct mail to `U.H.L` from user `S` | `mbx.U.H.L.S`                                  | stream `MBX_U` (subjects `mbx.U.>`)     |
| broadcast from user `S`              | `mbx.all.S`                                    | stream `MBX_ALL` (subjects `mbx.all.*`) |
| presence of a session                | KV bucket `presence`, key `U.H.<session hash>` | stream `KV_presence`                    |

- An address is `<user>.<host>.<label>`, each part `[a-z0-9-]+`. `all` is reserved.
- The last subject token is always the sender's user. The server enforces it with publish
  permissions (below), so it is the verified sender.
- Streams: file storage, limits retention, discard old, `max_age` 180 days, `max_bytes` 1 GiB,
  duplicate window 2 minutes, one replica, direct get on, delete and purge denied. Created by
  `server/mbox-admin.sh`.
- Publishers set `Nats-Msg-Id` to the envelope id, so a retried publish is stored once.
- Each session has one durable pull consumer on its user's stream, named after the session id,
  filtered to `mbx.U.H.L.*` for the address and each alias, explicit ack, `ack_wait` 60 s,
  `inactive_threshold` 30 days. Broadcasts are read with direct gets from the last seen sequence;
  a core subscription on `mbx.all.*` is only a wake-up.
- Ending a subscription (a receiver stopping, or a delivery daemon handing over to a newer one)
  stops the pull consumer first, waits for the deliveries already handed out to be acknowledged,
  then naks everything else without delay, in stream-sequence order, and flushes. A message the
  server sends in the instant the pull ends is seen by nobody and is redelivered after `ack_wait`.
- Starting a subscription reads the consumer's `num_ack_pending` and `delivered.stream_seq`. If
  messages are still unacknowledged (handed back by the previous reader, lost in that instant, or
  held by a reader that crashed or lost its connection), everything the pull receives is held
  until each of them is back (each sequence up to `delivered.stream_seq`, counted once), then
  offered sorted by stream sequence; after that, arrival order is stream order. The hold gives up
  after `ack_wait` plus max(5 s, half of `ack_wait`) (90 s with the default) and offers what it
  has, sorted. The server does not always redeliver nak'd messages in the order they were nak'd,
  so the sort matters even after a clean hand-back.
- Presence: KV bucket `presence`, history 1, TTL 30 minutes, refreshed every 10 minutes and
  deleted when the session ends.

### Presence entry

The value under `U.H.<session hash>` is JSON, written by user `U` only (publish permission
`$KV.presence.U.>`), so every field is self-asserted except the user itself (the key's first
token):

```json
{
  "address": "alice.laptop.web-1a2b",
  "aliases": ["alice.laptop.front"],
  "session": "sess-1",
  "agent": "claude-code",
  "user": "alice",
  "host": "laptop",
  "cwd": "/work/web",
  "pid": 4242,
  "repo": "acme/web",
  "branch": "feat/login",
  "role": "worker",
  "parent": "alice.laptop.mgr-9c8d",
  "status": "running the tests",
  "at": "2026-10-17T12:00:00.000Z"
}
```

| field    | meaning                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| `repo`   | `owner/name` from the git remote (`origin`, else the first) of `cwd`; `null` outside git |
| `branch` | the checked-out branch of `cwd`; `null` outside git or on a detached HEAD                |
| `role`   | `manager`, `worker` or `null`                                                            |
| `parent` | the address of the session that spawned this one, or `null`; need not be live            |
| `status` | one line, at most 120 characters, or `null`                                              |

The last five were added in 0.5.6, after `pid`; readers before that ignore them, and readers
since then treat a missing one as `null`. Readers keep a field only when it has that shape
(`src/core/session-meta.ts`), and only addresses and aliases that belong to `U`. All five are
display only: nothing in the mailbox grants a `parent` or a `manager` anything. The exact bytes
are pinned by `test/golden-presence.test.ts`.

### Delivery order

What a session is guaranteed (DECISIONS.md, "Delivery order across readers"):

- **Direct mail** reaches the session in stream order: the order the server stored it, which for
  one sender is the order of sending (`mbox send` waits for the server's acknowledgement). This
  holds within one reader and across readers: daemon handover, a daemon killed or restarted,
  reconnects, alias changes, `mbox wait` and `mbox watch` taking turns.
- **Exception:** a message unacknowledged when a reader starts that does not come back within
  the hold (above) is shown when it does, after newer mail; in practice that needs a server that
  redelivers late. (A previous reader that acknowledges a message after the next one started only
  makes the hold run to its end.)
- **Broadcasts** are read by sequence from the saved cursor, so they arrive in order among
  themselves. Between a broadcast and direct mail there is no order guarantee, even from one
  sender.
- **Cost:** none while a session has a single reader. When a reader starts with messages
  outstanding, newer mail waits for them: a clean handover hands them back at once (no visible
  delay); a crash, or a message lost in the instant a reader stopped, delays newer mail by up to
  about `ack_wait` (60 s; the hold ends after 90 s at most). Batching and throughput are
  unchanged (no `max_ack_pending` limit).
- Messages carry no sequence number in what the model sees; the wire formats are unchanged.

### Per-user permission block

Generated by `server/mbox-admin.sh permissions <name>`; shown for `alice`:

```
publish allow:
  mbx.*.*.*.alice                       send direct mail; the last token must be the sender
  mbx.all.alice                         broadcast, stamped with the sender
  $JS.API.INFO                          account info (mbox doctor)
  $JS.API.STREAM.INFO.MBX_ALICE         own stream position
  $JS.API.STREAM.INFO.MBX_ALL           broadcast stream position for new sessions
  $JS.API.CONSUMER.DURABLE.CREATE.MBX_ALICE.*   create / re-target own session consumers
  $JS.API.CONSUMER.INFO.MBX_ALICE.*
  $JS.API.CONSUMER.MSG.NEXT.MBX_ALICE.* pull own mail
  $JS.ACK.MBX_ALICE.>                   ack own mail
  $JS.API.DIRECT.GET.MBX_ALICE          mbox inbox, doctor read-back (own stream only)
  $JS.API.DIRECT.GET.MBX_ALL            read broadcasts without a shared consumer
  $JS.API.DIRECT.GET.KV_presence        list presence
  $JS.API.DIRECT.GET.KV_presence.$KV.presence.>
  $KV.presence.alice.>                  write own presence entries only
subscribe allow:
  mbx.all.*                             broadcast wake-ups
  _INBOX_alice.>                        private reply inbox (client inboxPrefix)
```

Everything else is denied. Any change here is a `needs-owner` change and needs a negative test in
`test/isolation.test.ts` (see CLAUDE.md).

### Envelope v1

JSON in the message payload:

```json
{
  "v": 1,
  "id": "<uuid>",
  "from": "alice.laptop.web-app-9f3e",
  "to": "bob.desktop.api-7c1d",
  "agent": "claude-code",
  "subject": null,
  "body": "text",
  "inReplyTo": null,
  "sentAt": "2026-10-17T12:00:00.000Z"
}
```

| field       | meaning                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`         | always `1`; a payload without `v: 1`, string `from` and string `body` is delivered as a raw message from `(raw message)`                              |
| `id`        | UUID made by the sender; what `--re` references and what de-duplicates (must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, else the broker's id is used) |
| `from`      | the sender's address, self-asserted; the verified user is the subject's last token, not this field                                                    |
| `to`        | the recipient address, or `all`                                                                                                                       |
| `agent`     | adapter id of the sending agent                                                                                                                       |
| `subject`   | optional one-line subject, else `null`                                                                                                                |
| `body`      | the message text, untrusted                                                                                                                           |
| `inReplyTo` | the id this replies to, else `null`                                                                                                                   |
| `sentAt`    | ISO 8601 send time; a message older than 24 hours is flagged stale                                                                                    |

Source of truth: `src/core/envelope.ts` (the `Envelope` type is in `src/core/types.ts`); the exact
JSON is pinned by `test/golden.test.ts`. Adding a field is backward compatible if readers ignore
unknown fields; changing the meaning of one needs a new `v`.
