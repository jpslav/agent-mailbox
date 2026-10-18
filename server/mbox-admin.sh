#!/bin/sh
# Administer agent-mailbox users on the NATS server. Run on the mailbox host.
#
#   mbox-admin.sh init                       admin user + MBX_ALL stream + presence and sharing KV
#                                            buckets (+ each user's events stream, for upgrades)
#   mbox-admin.sh add-user <name>            user + permissions + MBX_<NAME> and EVT_<NAME> streams;
#                                            prints the `mbox setup` line
#   mbox-admin.sh remove-user <name> [--delete-stream]
#   mbox-admin.sh list-users [--sharing]
#   mbox-admin.sh set-sharing <name> team|private   who may read <name>'s events feed
#   mbox-admin.sh permissions <name>         print the permission block a user would get (no changes)
#
# Environment (defaults in brackets):
#   MBOX_CONF_DIR      directory holding nats-server.conf [$(brew --prefix)/etc/agent-mailbox if
#                      Homebrew is installed, else /etc/agent-mailbox]
#                      The script owns users.conf, users.d/ and admin.creds in it.
#   NATS_URL           where the admin connects [derived from `listen` in nats-server.conf (a
#                      wildcard address becomes 127.0.0.1), else nats://127.0.0.1:4222]
#   MBOX_PUBLIC_URL    server URL printed in the `mbox setup` line [derived from `listen`]
#   MBOX_PID_FILE      nats-server pid file used for the reload signal [pid_file from the conf]
#   MBOX_MAX_AGE       retention per mailbox stream [180d]     MBOX_MAX_BYTES  size cap per stream [1GiB]
#   MBOX_PRESENCE_TTL  presence entry lifetime [30m]
#   MBOX_EVENTS_MAX_AGE retention per events stream [30d]  MBOX_EVENTS_MAX_BYTES  its size cap [64MiB]
#   MBOX_DEFAULT_SHARING  events feed sharing for users add-user creates [team]
#   MBOX_RELOAD_SETTLE seconds to let a server reload finish before re-checking that the streams
#                      just created still exist [1]
#   NATS_BIN, NATS_SERVER_BIN   the `nats` CLI and `nats-server` [found on PATH]
#
# Users and permissions live in users.d/<name>.conf (one block per user); users.conf is regenerated
# from them on every change and pulled into the server config with `include "users.conf"`. The
# server is then reloaded with `nats-server --signal reload=<pid>` (SIGHUP; connections stay up,
# removed users are disconnected). Passwords are generated here, stored only as bcrypt hashes
# (`nats server passwd`, password passed via the environment, never argv), and printed once.
#
# Events feeds: users.d/<name>.sharing holds `team` or `private` (no file: team). A user's
# permissions name every feed shared with the team, so every change to a user or a sharing
# setting regenerates every user's block (keeping its password hash) before users.conf. The
# sharing bucket's key `team` lists the shared feeds for clients (`mbox events --all`); the
# permissions, not that list, decide who reads what.
set -eu

# Platform default: Homebrew's prefix when brew exists (macOS, Linuxbrew), else the FHS location.
default_conf_dir() {
  if command -v brew >/dev/null 2>&1 && prefix=$(brew --prefix 2>/dev/null) && [ -n "$prefix" ]; then
    echo "$prefix/etc/agent-mailbox"
  else
    echo /etc/agent-mailbox
  fi
}

CONF_DIR=${MBOX_CONF_DIR:-$(default_conf_dir)}
SERVER_CONF="$CONF_DIR/nats-server.conf"
USERS_CONF="$CONF_DIR/users.conf"
USERS_DIR="$CONF_DIR/users.d"
CREDS="$CONF_DIR/admin.creds"
ADMIN_USER=mbx_admin  # '_' cannot appear in mailbox user names, so this never collides
NATS=${NATS_BIN:-nats}
NATS_SERVER=${NATS_SERVER_BIN:-nats-server}
MAX_AGE=${MBOX_MAX_AGE:-180d}
MAX_BYTES=${MBOX_MAX_BYTES:-1GiB}
PRESENCE_TTL=${MBOX_PRESENCE_TTL:-30m}
EVENTS_MAX_AGE=${MBOX_EVENTS_MAX_AGE:-30d}
EVENTS_MAX_BYTES=${MBOX_EVENTS_MAX_BYTES:-64MiB}
DEFAULT_SHARING=${MBOX_DEFAULT_SHARING:-team}
SETTLE=${MBOX_RELOAD_SETTLE:-1}
USERS_CHANGED=1  # set by rebuild_users_conf: did users.conf's content change?

die() { echo "mbox-admin: $*" >&2; exit 1; }
usage() {
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

gen_password() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }
bcrypt() { PASSWORD=$1 "$NATS" server passwd </dev/null; }

valid_name() {
  case $1 in
    ''|-*|*[!a-z0-9-]*) die "user names must match [a-z0-9-]+ and not start with '-' (got '$1')" ;;
  esac
  [ "${#1}" -le 32 ] || die "user names are at most 32 characters"
  [ "$1" != all ] || die "'all' is reserved (broadcast)"
}

stream_of() { printf 'MBX_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }
events_stream_of() { printf 'EVT_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

valid_sharing() {
  case $1 in
    team|private) ;;
    *) die "sharing must be team or private (got '$1')" ;;
  esac
}

# Functions below that loop or are called from loops use variables prefixed with their own name:
# POSIX sh has no local variables, and a shared name would clobber the caller's.

# The mailbox users (users.d/<name>.conf, without the admin), one per line, sorted.
user_names() {
  for un_f in "$USERS_DIR"/*.conf; do
    [ -f "$un_f" ] || continue
    un_n=$(basename "$un_f" .conf)
    [ "$un_n" = _admin ] && continue
    echo "$un_n"
  done
}

# $1's events feed sharing: team or private (no file, or anything else in it: team).
sharing_of() {
  if [ -f "$USERS_DIR/$1.sharing" ] && [ "$(cat "$USERS_DIR/$1.sharing")" = private ]; then
    echo private
  else
    echo team
  fi
}

# The users whose feed is shared with the team, one per line.
team_users() {
  for tu_n in $(user_names); do
    [ "$(sharing_of "$tu_n")" = team ] && echo "$tu_n"
  done
  return 0
}

# ---------------------------------------------------------------- permissions
# The complete, minimal permission set for mailbox user $1 (see README, "Permissions"). It names
# every other user's events feed that is shared with the team, as users.d says now.
permissions() {
  u=$1; s=$(stream_of "$1"); e=$(events_stream_of "$1")
  pm_team=
  for pm_t in $(team_users); do
    [ "$pm_t" = "$u" ] && continue
    pm_team="$pm_team        \"\$JS.API.DIRECT.GET.$(events_stream_of "$pm_t")\",  # $pm_t's events feed (shared with the team)
"
  done
  cat <<EOF
    permissions: {
      publish: { allow: [
        "mbx.*.*.*.$u",  # send direct mail; the last token must be the sender
        "mbx.all.$u",  # broadcast, also stamped with the sender
        "\$JS.API.INFO",  # account info (mbox doctor)
        "\$JS.API.STREAM.INFO.$s",  # own mailbox stream
        "\$JS.API.STREAM.INFO.MBX_ALL",  # broadcast stream position for new sessions
        "\$JS.API.CONSUMER.DURABLE.CREATE.$s.*",  # create / re-target own session consumers
        "\$JS.API.CONSUMER.INFO.$s.*",
        "\$JS.API.CONSUMER.MSG.NEXT.$s.*",  # pull own mail
        "\$JS.ACK.$s.>",  # ack own mail
        "\$JS.API.DIRECT.GET.$s",  # mbox inbox / doctor read-back (own stream only)
        "\$JS.API.DIRECT.GET.MBX_ALL",  # read broadcasts without a shared consumer
        "\$JS.API.DIRECT.GET.KV_presence",  # list the presence bucket
        "\$JS.API.DIRECT.GET.KV_presence.\$KV.presence.>",
        "evt.$u.*",  # write own events feed only (evt.<user>.<host>)
        "\$JS.API.DIRECT.GET.$e",  # read own events feed
$pm_team        "\$JS.API.DIRECT.GET.KV_sharing.\$KV.sharing.team",  # which feeds are shared (key team only)
        "\$KV.presence.$u.>"  # write only own presence entries
      ] }
      subscribe: { allow: [
        "mbx.all.*",  # broadcast wake-ups
        "_INBOX_$u.>"  # private reply inbox (client inboxPrefix)
      ] }
    }
EOF
}

user_block() {
  # $1 name, $2 bcrypt hash, $3 permissions (empty for the admin)
  printf '  # %s (written by mbox-admin.sh %s)\n  {\n    user: "%s"\n    password: "%s"\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
  [ -z "$3" ] || printf '%s\n' "$3"
  printf '  }\n'
}

# Rewrite users.d/$1.conf with the current permissions, keeping its first line (the comment with
# the creation date) and its password hash, so an unchanged block stays byte for byte the same.
regen_user() {
  ru_f="$USERS_DIR/$1.conf"
  ru_comment=$(sed -n 1p "$ru_f")
  ru_hash=$(sed -n 's/^    password: "\(.*\)"$/\1/p' "$ru_f" | head -n 1)
  [ -n "$ru_hash" ] || die "no password hash in $ru_f"
  ru_tmp="$ru_f.tmp.$$"
  {
    printf '%s\n  {\n    user: "%s"\n    password: "%s"\n' "$ru_comment" "$1" "$ru_hash"
    permissions "$1"
    printf '  }\n'
  } >"$ru_tmp"
  chmod 600 "$ru_tmp"
  if cmp -s "$ru_tmp" "$ru_f"; then rm -f "$ru_tmp"; else mv "$ru_tmp" "$ru_f"; fi
}

rebuild_users_conf() {
  for rb_n in $(user_names); do regen_user "$rb_n"; done
  tmp="$USERS_CONF.tmp.$$"
  {
    echo "# GENERATED by server/mbox-admin.sh from users.d/ -- do not edit by hand."
    echo "accounts {"
    echo "  MAILBOX {"
    echo "    jetstream: enabled"
    echo "    users: ["
    for f in "$USERS_DIR"/*.conf; do
      [ -f "$f" ] && cat "$f"
    done
    echo "    ]"
    echo "  }"
    echo "}"
  } >"$tmp"
  chmod 600 "$tmp"
  if [ -f "$USERS_CONF" ] && cmp -s "$tmp" "$USERS_CONF"; then
    rm -f "$tmp"
    USERS_CHANGED=0
  else
    mv "$tmp" "$USERS_CONF"
    USERS_CHANGED=1
  fi
}

pid_file() {
  if [ -n "${MBOX_PID_FILE:-}" ]; then echo "$MBOX_PID_FILE"; return; fi
  [ -f "$SERVER_CONF" ] && sed -n 's/^[[:space:]]*pid_file[[:space:]]*[:=][[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$SERVER_CONF" | head -n 1
}

reload_server() {
  pf=$(pid_file)
  if [ -n "$pf" ] && [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
    "$NATS_SERVER" --signal "reload=$(cat "$pf")" >/dev/null
    echo "reloaded nats-server (pid $(cat "$pf"))"
    return 0
  fi
  echo "nats-server is not running (no live pid in '${pf:-<no pid_file>}'); the change applies when it starts."
  return 1
}

load_admin() {
  [ -f "$CREDS" ] || die "no $CREDS; run: $0 init"
  NATS_USER=$(sed -n 's/^user=//p' "$CREDS")
  NATS_PASSWORD=$(sed -n 's/^password=//p' "$CREDS")
  export NATS_USER NATS_PASSWORD
}

server_up() { "$NATS" account info >/dev/null 2>&1; }

# Wait until a reload has taken effect: $1 user, $2 password.
wait_auth() {
  i=0
  while [ $i -lt 50 ]; do
    if NATS_USER=$1 NATS_PASSWORD=$2 "$NATS" --inbox-prefix "_INBOX_$1" account info >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

add_stream() {
  # $1 name, $2 subjects [, $3 max age, $4 max bytes: default the mailbox's]
  age=${3:-$MAX_AGE}; bytes=${4:-$MAX_BYTES}
  if "$NATS" stream info "$1" >/dev/null 2>&1; then echo "stream $1 already exists (kept)"; return; fi
  "$NATS" stream add "$1" --subjects "$2" --storage file --retention limits --discard old \
    --max-age "$age" --max-bytes "$bytes" --max-msgs=-1 --max-msgs-per-subject=-1 --max-msg-size=-1 \
    --dupe-window 2m --replicas 1 --allow-direct --deny-delete --deny-purge --no-allow-rollup \
    --description "agent-mailbox" --defaults >/dev/null
  echo "created stream $1 ($2, file storage, max-age $age, max-bytes $bytes, discard old)"
}

# The subject must be a wildcard: a stream on a literal subject would also store a push consumer's
# deliveries to it, from any user (see docs/PROTOCOL.md, "Events feeds").
add_events_stream() { add_stream "$(events_stream_of "$1")" "evt.$1.*" "$EVENTS_MAX_AGE" "$EVENTS_MAX_BYTES"; }

# The sharing list clients read (key `team` of the sharing bucket): a JSON array of user names.
team_json() {
  tj_out=
  for tj_t in $(team_users); do tj_out="$tj_out${tj_out:+,}\"$tj_t\""; done
  printf '[%s]' "$tj_out"
}
publish_sharing() {
  want=$(team_json)
  have=$("$NATS" kv get sharing team --raw 2>/dev/null || true)
  [ "$have" = "$want" ] && return 0
  "$NATS" kv put sharing team "$want" >/dev/null || die "could not write the sharing list (kv bucket sharing)"
  echo "sharing list updated: feeds shared with the team: $want"
}

# A stream created while the server is still applying a reload can be lost when the reload finishes
# (seen on a busy machine, nats-server 2.15). So: reload only when users.conf really changed, and
# after a reload let it settle, then re-check what was just created and recreate it if it is gone.
# $1 check command (succeeds when everything exists), $2 command that (re)creates it.
settle() {
  i=0
  while [ $i -lt 5 ]; do
    sleep "$SETTLE"
    if "$1"; then return 0; fi
    echo "stream or bucket lost during the server reload; recreating it"
    "$2"
    i=$((i + 1))
  done
  "$1" || die "still missing after the server reload; check the server log and re-run"
}

# init's streams and buckets: the shared ones, and every user's events stream (users that existed
# before events feeds get theirs on the first init after the upgrade).
check_base() {
  "$NATS" stream info MBX_ALL >/dev/null 2>&1 && "$NATS" kv info presence >/dev/null 2>&1 &&
    "$NATS" kv info sharing >/dev/null 2>&1 || return 1
  for cb_n in $(user_names); do
    "$NATS" stream info "$(events_stream_of "$cb_n")" >/dev/null 2>&1 || return 1
  done
}
ensure_base() {
  add_stream MBX_ALL 'mbx.all.*'
  if "$NATS" kv info presence >/dev/null 2>&1; then
    echo "kv bucket presence already exists (kept)"
  else
    "$NATS" kv add presence --history 1 --ttl "$PRESENCE_TTL" --storage file --replicas 1 >/dev/null
    echo "created kv bucket presence (history 1, ttl $PRESENCE_TTL)"
  fi
  if "$NATS" kv info sharing >/dev/null 2>&1; then
    echo "kv bucket sharing already exists (kept)"
  else
    "$NATS" kv add sharing --history 5 --storage file --replicas 1 >/dev/null
    echo "created kv bucket sharing (history 5)"
  fi
  for eb_n in $(user_names); do add_events_stream "$eb_n"; done
}

# add-user's streams, named by $USER_NAME.
check_user_stream() {
  "$NATS" stream info "$(stream_of "$USER_NAME")" >/dev/null 2>&1 &&
    "$NATS" stream info "$(events_stream_of "$USER_NAME")" >/dev/null 2>&1
}
ensure_user_stream() {
  add_stream "$(stream_of "$USER_NAME")" "mbx.$USER_NAME.>"
  add_events_stream "$USER_NAME"
}

public_url() {
  if [ -n "${MBOX_PUBLIC_URL:-}" ]; then echo "$MBOX_PUBLIC_URL"; return; fi
  l=$( [ -f "$SERVER_CONF" ] && sed -n 's/^[[:space:]]*listen[[:space:]]*[:=][[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$SERVER_CONF" | head -n 1)
  case $l in
    '') echo "nats://<mailbox-host>:4222" ;;
    0.0.0.0:*|127.0.0.1:*|'[::]':*) echo "nats://<mailbox-host>:${l##*:}" ;;
    *) echo "nats://$l" ;;
  esac
}

# ---------------------------------------------------------------- commands
cmd_init() {
  umask 077
  mkdir -p "$USERS_DIR"
  if [ ! -f "$CREDS" ]; then
    pw=$(gen_password)
    user_block "$ADMIN_USER" "$(bcrypt "$pw")" "" >"$USERS_DIR/_admin.conf"
    printf 'user=%s\npassword=%s\n' "$ADMIN_USER" "$pw" >"$CREDS"
    chmod 600 "$CREDS" "$USERS_DIR/_admin.conf"
    echo "created admin user $ADMIN_USER (credentials in $CREDS, mode 0600)"
  fi
  rebuild_users_conf
  load_admin
  reloaded=0
  if [ "$USERS_CHANGED" = 1 ]; then
    if reload_server; then reloaded=1; wait_auth "$NATS_USER" "$NATS_PASSWORD" || true; fi
  else
    echo "users.conf unchanged: no server reload needed"
  fi
  if ! server_up; then
    echo "server not reachable at $NATS_URL as $ADMIN_USER: start nats-server (see server/install.sh), then run '$0 init' again to create the streams."
    return 0
  fi
  ensure_base
  if [ "$reloaded" = 1 ]; then settle check_base ensure_base; fi
  publish_sharing
}

cmd_add_user() {
  name=$1; valid_name "$name"
  umask 077
  load_admin
  [ ! -f "$USERS_DIR/$name.conf" ] || die "user $name already exists (remove-user first to reset the password)"
  valid_sharing "$DEFAULT_SHARING"
  pw=$(gen_password)
  printf '%s\n' "$DEFAULT_SHARING" >"$USERS_DIR/$name.sharing"
  chmod 600 "$USERS_DIR/$name.sharing"
  user_block "$name" "$(bcrypt "$pw")" "$(permissions "$name")" >"$USERS_DIR/$name.conf"
  chmod 600 "$USERS_DIR/$name.conf"
  rebuild_users_conf
  reload_server || die "user written to $USERS_DIR/$name.conf, but the server must be running to create the stream; start it and re-run add-user after remove-user"
  wait_auth "$name" "$pw" || die "the server did not accept the new user after reload; check its log"
  USER_NAME=$name
  ensure_user_stream
  settle check_user_stream ensure_user_stream
  publish_sharing
  echo "events feed sharing for $name: $(sharing_of "$name") (change it with: $0 set-sharing $name team|private)"
  url=$(public_url)
  echo
  echo "Created mailbox user '$name'. Send them this line privately (it contains their password);"
  echo "they run it on each machine:"
  echo
  printf '%s\n' "  printf '%s\\n' '$pw' | mbox setup --servers $url --user $name --password-stdin"
  echo
  echo "then:  mbox doctor"
}

cmd_remove_user() {
  name=$1; valid_name "$name"
  load_admin
  [ -f "$USERS_DIR/$name.conf" ] || die "no such user: $name"
  rm -f "$USERS_DIR/$name.conf" "$USERS_DIR/$name.sharing"
  rebuild_users_conf
  reload_server || true
  echo "removed user $name (their connections are closed by the reload)"
  if server_up; then publish_sharing; else echo "server not reachable: run '$0 init' once it runs, to update the sharing list"; fi
  if [ "${2:-}" = "--delete-stream" ]; then
    "$NATS" stream rm -f "$(stream_of "$name")" >/dev/null && echo "deleted stream $(stream_of "$name") and its messages"
    "$NATS" stream rm -f "$(events_stream_of "$name")" >/dev/null 2>&1 && echo "deleted stream $(events_stream_of "$name") and its events"
  else
    echo "kept streams $(stream_of "$name") and $(events_stream_of "$name") (mail ages out after $MAX_AGE, events after $EVENTS_MAX_AGE; pass --delete-stream to drop them now)"
  fi
}

cmd_set_sharing() {
  name=$1; valid_name "$name"; valid_sharing "$2"
  umask 077
  load_admin
  [ -f "$USERS_DIR/$name.conf" ] || die "no such user: $name"
  printf '%s\n' "$2" >"$USERS_DIR/$name.sharing"
  chmod 600 "$USERS_DIR/$name.sharing"
  rebuild_users_conf
  if [ "$USERS_CHANGED" = 1 ]; then
    # Permissions first: a feed made private stops being readable before the list says so.
    reload_server || die "sharing saved in $USERS_DIR/$name.sharing, but the server must be running to apply it; start it and run '$0 init'"
  else
    echo "users.conf unchanged: no server reload needed"
  fi
  if server_up; then publish_sharing; fi
  case $2 in
    team) echo "events feed of $name: team (every mailbox user can read it)" ;;
    private) echo "events feed of $name: private (only $name can read it)" ;;
  esac
}

cmd_list_users() {
  for lu_n in $(user_names); do
    if [ "${1:-}" = --sharing ]; then echo "$lu_n $(sharing_of "$lu_n")"; else echo "$lu_n"; fi
  done
}

# Where the admin connects: NATS_URL if set, else the server's own `listen` address.
if [ -z "${NATS_URL:-}" ]; then
  l=
  if [ -f "$SERVER_CONF" ]; then
    l=$(sed -n 's/^[[:space:]]*listen[[:space:]]*[:=][[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$SERVER_CONF" | head -n 1)
  fi
  case $l in
    '') NATS_URL=nats://127.0.0.1:4222 ;;
    0.0.0.0:*|'[::]':*) NATS_URL=nats://127.0.0.1:${l##*:} ;;
    *) NATS_URL=nats://$l ;;
  esac
fi
export NATS_URL

cmd=${1:-}
case $cmd in
  init) cmd_init ;;
  add-user) [ $# -ge 2 ] || usage; cmd_add_user "$2" ;;
  remove-user) [ $# -ge 2 ] || usage; cmd_remove_user "$2" "${3:-}" ;;
  list-users) cmd_list_users "${2:-}" ;;
  set-sharing) [ $# -ge 3 ] || usage; cmd_set_sharing "$2" "$3" ;;
  permissions) [ $# -ge 2 ] || usage; valid_name "$2"; permissions "$2" ;;
  *) usage ;;
esac
