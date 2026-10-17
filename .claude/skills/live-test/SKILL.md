---
name: live-test
description: Run the live end-to-end test of agent-mailbox with two real Claude Code sessions counting 1 to 40 over a throwaway server. Use after any change to delivery, hooks, the inbox-socket code or the delivery daemon, and whenever a new Claude Code version might have changed the inbox-socket protocol (docs/PROTOCOL.md).
---

# Live test: two real sessions, a throwaway server

Unit and integration tests use a fake inbox socket; only this test proves that real Claude Code
sessions receive mail. It uses a temporary server, a temporary client config and state directory,
and never touches a real mailbox server or the real client config.

Rules:

- Both sessions run in **visible terminals where a human can watch**: the desktop app's Terminal
  panel, or the person's own terminal. Never launch autonomous headless Claude sessions
  (`claude -p`, background spawns), and never change a permission mode to make the test easier.
  The human approves the sessions' `mbox send` prompts.
- Do the setup in one shell (variables persist); the setup writes `$LT/env.sh`, which every other
  terminal sources (`. <scratch dir>/env.sh`).

## 1. Throwaway server and client config

Run from the repository root, in a visible terminal. Needs `nats-server` (>= 2.11), the `nats` CLI,
and Node.js >= 18 on `PATH`.

```sh
REPO=$(git rev-parse --show-toplevel)
LT=$(mktemp -d "${TMPDIR:-/tmp}/mbox-live.XXXXXX")
PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
mkdir -p "$LT/conf" "$LT/store" "$LT/client" "$LT/ping" "$LT/pong"
sed -e "s|^listen: .*|listen: \"127.0.0.1:$PORT\"|" \
    -e 's|^http: .*|# http monitoring disabled|' \
    -e "s|^pid_file: .*|pid_file: \"$LT/nats.pid\"|" \
    -e "s|^\([[:space:]]*\)store_dir: .*|\1store_dir: \"$LT/store\"|" \
    "$REPO/server/nats-server.conf.example" > "$LT/conf/nats-server.conf"
cat > "$LT/env.sh" <<EOF2
export REPO="$REPO" LT="$LT"
export MBOX_CONF_DIR="$LT/conf" NATS_URL="nats://127.0.0.1:$PORT" MBOX_PUBLIC_URL="nats://127.0.0.1:$PORT"
export AGENT_MAILBOX_CONFIG="$LT/client/config.json" AGENT_MAILBOX_STATE_DIR="$LT/client/state"
export PATH="$REPO/adapters/claude-code/bin:\$PATH"
EOF2
. "$LT/env.sh"
sh "$REPO/server/mbox-admin.sh" init                        # server is not running yet: writes users.conf and the admin credentials
nats-server -c "$LT/conf/nats-server.conf" > "$LT/server.log" 2>&1 &
echo $! > "$LT/server.pid"
for i in $(seq 1 100); do grep -q 'Server is ready' "$LT/server.log" && break; sleep 0.2; done
grep 'Server is ready' "$LT/server.log"
sh "$REPO/server/mbox-admin.sh" init                        # creates the MBX_ALL stream and the presence bucket
sh "$REPO/server/mbox-admin.sh" add-user alice > "$LT/add-alice.txt"
grep 'mbox setup' "$LT/add-alice.txt" > "$LT/setup.sh"      # the printed `printf ... | mbox setup ...` line
sh "$LT/setup.sh"
mbox doctor                                                 # every line must pass
echo "scratch dir: $LT"
```

Both sessions use the one user `alice` (and so share one delivery daemon, as two sessions of one
person do). `mbox` here is the launcher in the repository; a `--plugin-dir` session overrides an
installed copy of the plugin for that session.

## 2. Two sessions in visible terminals

In two separate terminals (the desktop app's Terminal panel tabs, or two terminal windows), with
`<scratch dir>` the path step 1 printed:

```sh
. <scratch dir>/env.sh
cd "$LT/ping" && claude --plugin-dir "$REPO/adapters/claude-code"      # terminal 1; use "$LT/pong" in terminal 2
```

The directory name becomes the session's label, so the addresses look like `alice.<host>.ping-xxxx`.

Expect two one-time prompts in each new session, and let the human answer them: Claude Code's
workspace trust dialog (the scratch folders are new, so "Yes, I trust this folder" is needed) and,
on machines with the Claude in Chrome extension, a browser-tools prompt (keep them off).

Paste this as the first message of terminal 1 (PING). The wording matters, copy it exactly:

> Mailbox ping-pong test (session PING). Do not edit any files or do anything else. Tell me your mailbox address in one line, then stop. Whenever a [mailbox] message arrives: if its body is just a number N below 40, reply to its sender with mbox send, with the body being only N+1, then stop. If N is 40 or more, reply with the word done and stop. If the body is an instruction from the orchestrator to send a number to an address, do exactly that once, then stop.

Paste this as the first message of terminal 2 (PONG):

> Mailbox ping-pong test (session PONG). Do not edit any files or do anything else. Tell me your mailbox address in one line, then stop. Whenever a [mailbox] message arrives: if its body is just a number N below 40, reply to its sender with mbox send, with the body being only N+1, then stop. If N is 40 or more, reply with the word done and stop.

Each session prints its address. Approve `mbox send` prompts as they appear. Check
`mbox peers` (in a third terminal with `. <scratch dir>/env.sh`) lists both.

## 3. Kick off

In a third terminal, with `PING` and `PONG` set to the two addresses the sessions printed:

```sh
. <scratch dir>/env.sh
AGENT_MAILBOX_SESSION=orchestrator mbox send "$PING" "Orchestrator instruction: send the number 1 to $PONG with mbox send, once, then stop."
```

The sessions now exchange 1, 2, ... 40 on their own (about 4 seconds per hop, 3 to 4 minutes in
all) and the last one says `done`. Do not nudge them or type into them during the volley, except
for the typing check below.

## 4. Verify the tally

Each session's id is the name of the state file that holds its address; read each inbox with it:

```sh
PING_SID=$(basename "$(grep -l "\"$PING\"" "$AGENT_MAILBOX_STATE_DIR"/sessions/*.json)" .json)
PONG_SID=$(basename "$(grep -l "\"$PONG\"" "$AGENT_MAILBOX_STATE_DIR"/sessions/*.json)" .json)
for s in "$PING_SID" "$PONG_SID"; do
  echo "== $s"
  mbox inbox --session "$s" --since 1h | awk '/^\[mailbox\] end /{print prev} {prev=$0}'
done
```

Pass criteria for the tally (all of them):

- PING's inbox holds the orchestrator instruction and exactly the even numbers 2, 4, ..., 40;
  PONG's holds exactly the odd numbers 1, 3, ..., 39 and then `done`. Nothing missing, nothing
  twice, nothing out of order.
- The count of `[mailbox] message` blocks is 21 in each inbox (20 numbers plus the instruction or
  `done`): `mbox inbox --session "$s" --since 1h | grep -c '^\[mailbox\] message '`.
- The volley finished without any human nudge, and no session reports it was cut off, refused or
  rate limited (Claude Code's relay-loop cap must not cut it; the mailbox's own limit is 30
  messages per session per minute and 40 rounds at about 4 s each stays below it).

## 5. Desktop-app checklist

Repeat steps 2 to 4 with both sessions as sessions in the Claude desktop app, started on the same
plugin directory (`--plugin-dir` equivalent: the app's plugin setting, or an installed copy of the
branch's plugin) in directories `$LT/ping` and `$LT/pong`, with the same environment variables
available to the app. While doing so, check each item:

- [ ] Delivery wakes an idle session: a message sent to an idle session starts a turn by itself.
- [ ] No running task and no stuck busy indicator shows in either session before, during or after
      the volley (nothing is left running inside a session).
- [ ] The user can type in a session in the middle of the volley, and the typed message is handled
      instead of being queued behind something.
- [ ] Closing (archiving) a session deregisters it: it disappears from `mbox peers` within a
      moment, and `mbox deliverd --status` no longer lists it.

## 6. Pass criteria and clean up

The test passes when the tally in step 4 is exact in the terminal run and the desktop checklist in
step 5 is fully ticked (skip step 5 only when nothing in the change can differ between the two).
Record the result (Claude Code version from `claude --version`, pass or fail, anything odd) in the
PR. A failure of a previously passing test on a new Claude Code version means the protocol may
have changed: see `docs/PROTOCOL.md`, "Signs that the protocol changed".

Clean up (the delivery daemon exits by itself 10 minutes after its last session is gone):

```sh
kill "$(cat "$LT/server.pid")"
rm -rf "$LT"
```
