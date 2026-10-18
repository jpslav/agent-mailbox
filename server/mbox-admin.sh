#!/bin/sh
# Administer agent-mailbox users on the NATS server. Run on the mailbox host.
#
#   mbox-admin.sh init                       admin user + MBX_ALL stream + presence and sharing KV buckets
#                                            (+ each user's events stream); upgrades older layouts
#   mbox-admin.sh add-user <name>            user + own account + MBX_<NAME> and EVT_<NAME> streams;
#                                            prints the `mbox setup` line
#   mbox-admin.sh remove-user <name> [--delete-stream]
#   mbox-admin.sh list-users [--sharing]
#   mbox-admin.sh set-sharing <name> team|private   who may read <name>'s events feed
#   mbox-admin.sh permissions <name>         print what a user may do: their account and its imports (no changes)
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
#   MBOX_RELOAD_SETTLE seconds to let a server reload finish before the next step (the second
#                      reload, re-checking that the streams just created still exist) [1]
#   NATS_BIN, NATS_SERVER_BIN   the `nats` CLI and `nats-server` [found on PATH]
#
# Layout (docs/DECISIONS.md, "Per-user accounts"): the account MAILBOX holds JetStream, every
# stream, the presence bucket and the admin user. Each mailbox user has an account of their own,
# USER_<name>, without JetStream, that imports exactly the services the client needs from MAILBOX:
# publishing subjects that end in the user's own name, and the JetStream API calls on their own
# stream and on the shared ones. Replies to a user's requests are therefore delivered inside the
# user's own account, where no stream can capture them.
#
# Events feeds (docs/DECISIONS.md, "Events feeds"): each user's stream EVT_<NAME> on evt.<name>.*.
# users.d/<name>.sharing holds `team` or `private` (no file: team). The stream account exports the
# direct get on a user's feed to that user's account and, while the feed is `team`, to every other
# user account, which imports it; so every change to a user or a sharing setting regenerates the
# whole users.conf. The sharing bucket's key `team` lists the shared feeds for clients
# (`mbox events --all`); the exports, not that list, decide who reads what.
#
# Users live in users.d/<name>.conf (name and bcrypt hash); users.conf is regenerated from them on
# every change and pulled into the server config with `include "users.conf"`. The server is then
# reloaded with `nats-server --signal reload=<pid>` (SIGHUP; connections stay up, removed users
# and users whose account changed are disconnected and reconnect). Passwords are generated here,
# stored only as bcrypt hashes (`nats server passwd`, password passed via the environment, never
# argv), and printed once.
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
PENDING="$CONF_DIR/users.conf.pending"  # users.conf changed; the running server has not reloaded it yet
BACKUP_DIR="$CONF_DIR/pre-accounts-backup"  # users.conf and users.d/ as they were before the upgrade
LAYOUT_MARK='# layout: per-user accounts'  # in users.conf; absent from files written before 0.5.8
ADMIN_USER=mbx_admin  # '_' cannot appear in mailbox user names, so this never collides
STREAM_ACCOUNT=MAILBOX  # the account holding JetStream; its name predates the per-user accounts
WAKE='mbxwake.all.*'  # where MBX_ALL republishes the headers of each broadcast (wake-ups)
WAKE_DEST='mbxwake.all.{{wildcard(1)}}'
NATS=${NATS_BIN:-nats}
NATS_SERVER=${NATS_SERVER_BIN:-nats-server}
MAX_AGE=${MBOX_MAX_AGE:-180d}
MAX_BYTES=${MBOX_MAX_BYTES:-1GiB}
PRESENCE_TTL=${MBOX_PRESENCE_TTL:-30m}
EVENTS_MAX_AGE=${MBOX_EVENTS_MAX_AGE:-30d}
EVENTS_MAX_BYTES=${MBOX_EVENTS_MAX_BYTES:-64MiB}
DEFAULT_SHARING=${MBOX_DEFAULT_SHARING:-team}
STREAM_AGE=  # add_stream's retention and size cap when set (events streams), else the mailbox's
STREAM_BYTES=
SETTLE=${MBOX_RELOAD_SETTLE:-1}

die() { echo "mbox-admin: $*" >&2; exit 1; }
usage() {
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//' >&2
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
account_of() { printf 'USER_%s' "$1"; }
events_stream_of() { printf 'EVT_%s' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

valid_sharing() {
  case $1 in
    team|private) ;;
    *) die "sharing must be team or private (got '$1')" ;;
  esac
}

# The bcrypt hash in a users.d file (either layout), checked so that nothing else can reach the
# generated config. The file's `user:` line is not read: the file name is the user name.
hash_of() {
  h=$(sed -n 's/^[[:space:]]*password:[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' "$1" | head -n 1)
  case $h in
    '$2'[aby]'$'[0-9][0-9]'$'*) ;;
    *) die "no bcrypt password hash in $1" ;;
  esac
  case $h in
    *[!./A-Za-z0-9\$]*) die "unexpected characters in the password hash in $1" ;;
  esac
  printf '%s' "$h"
}

# Mailbox user names, from users.d/ (the admin's file is _admin.conf).
user_names() {
  for f in "$USERS_DIR"/*.conf; do
    [ -f "$f" ] || continue
    n=$(basename "$f" .conf)
    [ "$n" = _admin ] && continue
    valid_name "$n"
    echo "$n"
  done
}

# Functions below that loop, or that callers' loops call, prefix their variables with their own
# initials: POSIX sh has no local variables, and a shared name would clobber the caller's.

# $1's events feed sharing: team or private (no file, or anything else in it: team).
sharing_of() {
  if [ -f "$USERS_DIR/$1.sharing" ] && [ "$(cat "$USERS_DIR/$1.sharing")" = private ]; then
    echo private
  else
    echo team
  fi
}

# The users whose events feed is shared with the team, one per line.
team_users() {
  for tu_n in $(user_names); do
    [ "$(sharing_of "$tu_n")" = team ] && echo "$tu_n"
  done
  return 0
}

# The events feeds user $1 may read: their own, then every other one shared with the team.
feeds_of() {
  echo "$1"
  for fo_t in $(team_users); do [ "$fo_t" = "$1" ] || echo "$fo_t"; done
}

# The accounts that may read user $1's feed: $1's own and, while it is team, every other user's.
feed_readers() {
  fr_out="\"$(account_of "$1")\""
  if [ "$(sharing_of "$1")" = team ]; then
    for fr_u in $(user_names); do
      [ "$fr_u" = "$1" ] || fr_out="$fr_out, \"$(account_of "$fr_u")\""
    done
  fi
  printf '%s' "$fr_out"
}

# ---------------------------------------------------------------- what a user may do
# The services a user's account imports from the stream account, one per line:
# "<subject> <response type>" (stream: the call answers with several messages).
# Shared by every user account:
shared_services() {
  cat <<'EOF'
$JS.API.INFO single
$JS.API.STREAM.INFO.MBX_ALL single
$JS.API.DIRECT.GET.MBX_ALL stream
$JS.API.DIRECT.GET.KV_presence stream
$JS.API.DIRECT.GET.KV_presence.$KV.presence.> stream
$JS.API.DIRECT.GET.KV_sharing.$KV.sharing.team single
EOF
}
# Only for user $1: publishing in their own name, and the calls on their own stream.
user_services() {
  u=$1; s=$(stream_of "$1")
  cat <<EOF
mbx.*.*.*.$u single
mbx.all.$u single
evt.$u.* single
\$KV.presence.$u.> single
\$JS.API.STREAM.INFO.$s single
\$JS.API.CONSUMER.DURABLE.CREATE.$s.* single
\$JS.API.CONSUMER.INFO.$s.* single
\$JS.API.CONSUMER.MSG.NEXT.$s.* stream
\$JS.ACK.$s.> single
\$JS.API.DIRECT.GET.$s stream
EOF
}

# The permission block of mailbox user $1 inside their own account (see README, "Users and
# permissions"). The account boundary is what isolates users; this block is defense in depth and
# what `mbox doctor`'s isolation check sees (a permission error).
permissions() {
  u=$1; s=$(stream_of "$1"); e=$(events_stream_of "$1")
  pm_team=
  for pm_t in $(feeds_of "$u"); do
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
$pm_team        "\$JS.API.DIRECT.GET.KV_sharing.\$KV.sharing.team",  # the list of shared feeds (that key only)
        "\$KV.presence.$u.>"  # write only own presence entries
      ] }
      subscribe: { allow: [
        "mbx.all.*",  # broadcast wake-ups
        "_INBOX_$u.>"  # private reply inbox (client inboxPrefix)
      ] }
    }
EOF
}

# One export of the stream account: $1 subject, $2 response type, $3 the accounts allowed to import it.
export_line() {
  rt=
  [ "$2" = stream ] && rt=', response_type: stream'
  printf '      { service: "%s"%s, accounts: [%s] }\n' "$1" "$rt" "$3"
}

# The account of mailbox user $1 with password hash $2.
account_block() {
  u=$1; a=$(account_of "$1")
  printf '  "%s" {\n' "$a"
  printf '    # no JetStream: everything %s can reach is imported from %s below\n' "$u" "$STREAM_ACCOUNT"
  printf '    users: [\n      {\n        user: "%s"\n        password: "%s"\n' "$u" "$2"
  permissions "$u" | sed 's/^/    /'
  printf '      }\n    ]\n    imports: [\n'
  { shared_services; user_services "$u"; } | while read -r subj _; do
    printf '      { service: { account: "%s", subject: "%s" } }\n' "$STREAM_ACCOUNT" "$subj"
  done
  for ab_f in $(feeds_of "$u"); do
    if [ "$ab_f" = "$u" ]; then ab_what='own events feed'; else ab_what="$ab_f's events feed"; fi
    printf '      { service: { account: "%s", subject: "%s" } }  # %s\n' "$STREAM_ACCOUNT" \
      "\$JS.API.DIRECT.GET.$(events_stream_of "$ab_f")" "$ab_what"
  done
  printf '      { stream: { account: "%s", subject: "%s" }, to: "mbx.all.*" }  # broadcast wake-ups\n' \
    "$STREAM_ACCOUNT" "$WAKE"
  printf '    ]\n  }\n'
}

# The stream account's exports for mailbox user $1 alone.
user_exports() {
  user_services "$1" | while read -r subj rt; do export_line "$subj" "$rt" "\"$(account_of "$1")\""; done
}

# The export of user $1's events feed: the direct get, to every account that may read it.
feed_export() {
  export_line "\$JS.API.DIRECT.GET.$(events_stream_of "$1")" stream "$(feed_readers "$1")"
}

# A users.d file: $1 name, $2 bcrypt hash, $3 "deny-all" for a mailbox user. This script reads only
# the name (the file name) and the hash; the deny-all block is for an mbox-admin.sh from before
# 0.5.8, which copies these files verbatim into the stream account: there they must lock the user
# out instead of granting them the whole account.
user_block() {
  printf '  # %s (written by mbox-admin.sh %s)\n  {\n    user: "%s"\n    password: "%s"\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
  if [ "${3:-}" = deny-all ]; then
    printf '    # deny-all: the real permissions are in the generated users.conf (mbox-admin.sh 0.5.8+)\n'
    printf '    permissions: { publish: { deny: ">" }, subscribe: { deny: ">" } }\n'
  fi
  printf '  }\n'
}

rebuild_users_conf() {
  tmp="$USERS_CONF.tmp.$$"
  # Assignments, so that set -e stops on a bad name or hash before anything is written.
  names=$(user_names)
  admin_hash=$(hash_of "$USERS_DIR/_admin.conf")
  accts=
  for u in $names; do
    h=$(hash_of "$USERS_DIR/$u.conf")
    accts="$accts${accts:+, }\"$(account_of "$u")\""
  done
  {
    echo "# GENERATED by server/mbox-admin.sh from users.d/ -- do not edit by hand."
    echo "$LAYOUT_MARK (see docs/DECISIONS.md)"
    echo "accounts {"
    echo "  $STREAM_ACCOUNT {"
    echo "    jetstream: enabled"
    printf '    users: [\n      { user: "%s", password: "%s" }\n    ]\n' "$ADMIN_USER" "$admin_hash"
    echo "    exports: ["
    if [ -n "$accts" ]; then
      shared_services | while read -r subj rt; do export_line "$subj" "$rt" "$accts"; done
      printf '      { stream: "%s", accounts: [%s] }  # broadcast wake-ups\n' "$WAKE" "$accts"
      for u in $names; do user_exports "$u"; done
      for u in $names; do feed_export "$u"; done
    fi
    echo "    ]"
    echo "  }"
    for u in $names; do
      h=$(hash_of "$USERS_DIR/$u.conf")
      account_block "$u" "$h"
    done
    echo "}"
  } >"$tmp"
  chmod 600 "$tmp"
  if [ -f "$USERS_CONF" ] && cmp -s "$tmp" "$USERS_CONF"; then
    rm -f "$tmp"
    return 0
  fi
  [ ! -f "$USERS_CONF" ] || cp -p "$USERS_CONF" "$USERS_CONF.prev"
  touch "$PENDING"
  mv "$tmp" "$USERS_CONF"
  # Never reload a server into a config it cannot parse.
  if [ -f "$SERVER_CONF" ] && ! err=$("$NATS_SERVER" -t -c "$SERVER_CONF" 2>&1); then
    # users.conf.pending stays: the restored file may itself not be loaded yet (an earlier run
    # was interrupted), and a needless reload costs nothing.
    if [ -f "$USERS_CONF.prev" ]; then mv "$USERS_CONF.prev" "$USERS_CONF"; else rm -f "$USERS_CONF"; fi
    die "the generated users.conf is invalid, kept the previous one: $err"
  fi
  rm -f "$USERS_CONF.prev"
}

# Did an older mbox-admin.sh write this configuration (one account holding every user)?
needs_upgrade() {
  if [ -f "$USERS_CONF" ] && ! grep -q "^$LAYOUT_MARK" "$USERS_CONF"; then return 0; fi
  for f in "$USERS_DIR"/*.conf; do
    if [ -f "$f" ] && grep -q 'allow:' "$f"; then return 0; fi
  done
  return 1
}

# Before 0.5.8 each users.d file held the user's permission block (an allow list); it now lives in
# the generated account. Rewrite those files to the user block with the deny-all block (the hash is
# kept), after saving users.conf and users.d/ once, as they were, for a rollback.
migrate_users_d() {
  needs_upgrade || return 0
  if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR.tmp.$$"
    [ ! -f "$USERS_CONF" ] || cp -p "$USERS_CONF" "$BACKUP_DIR.tmp.$$/"
    cp -Rp "$USERS_DIR" "$BACKUP_DIR.tmp.$$/"
    mv "$BACKUP_DIR.tmp.$$" "$BACKUP_DIR"
    echo "upgrading to per-user accounts; saved the previous users.conf and users.d/ in $BACKUP_DIR (for a rollback)"
  fi
  for f in "$USERS_DIR"/*.conf; do
    [ -f "$f" ] && grep -q 'allow:' "$f" || continue
    n=$(basename "$f" .conf)
    valid_name "$n"
    h=$(hash_of "$f")
    user_block "$n" "$h" deny-all >"$f.tmp.$$"
    chmod 600 "$f.tmp.$$"
    mv "$f.tmp.$$" "$f"
  done
}

pid_file() {
  if [ -n "${MBOX_PID_FILE:-}" ]; then echo "$MBOX_PID_FILE"; return; fi
  [ -f "$SERVER_CONF" ] && sed -n 's/^[[:space:]]*pid_file[[:space:]]*[:=][[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$SERVER_CONF" | head -n 1
}

# The pid of the running nats-server, or nothing.
server_pid() {
  pf=$(pid_file)
  if [ -n "$pf" ] && [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then cat "$pf"; fi
}

signal_reload() { "$NATS_SERVER" --signal "reload=$1" >/dev/null; }

# Reload the server, twice: nats-server (2.15) wires the imports of an account that a reload adds
# only on the next reload (docs/DECISIONS.md, "A new account's imports need a second reload").
# Callers test the result, which turns off `set -e` in here, so every failure is explicit;
# users.conf.pending stays until both signals went out.
reload_server() {
  pid=$(server_pid)
  if [ -n "$pid" ]; then
    signal_reload "$pid" || die "could not signal nats-server (pid $pid) to reload; re-run '$0 init'"
    sleep "$SETTLE"
    signal_reload "$pid" || die "could not signal nats-server (pid $pid) to reload again; re-run '$0 init'"
    rm -f "$PENDING"
    echo "reloaded nats-server (pid $pid; twice, so that new accounts get their imports)"
    return 0
  fi
  # Answering without a pid we can signal: the change would silently not apply.
  if server_up; then
    die "nats-server answers at $NATS_URL, but there is no live pid in '$(pid_file || true)' to send the reload to; set MBOX_PID_FILE (or pid_file in nats-server.conf) and re-run '$0 init'"
  fi
  rm -f "$PENDING"  # the server reads users.conf when it starts
  echo "nats-server is not running (no live pid in '$(pid_file || true)'); the change applies when it starts."
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

# What mailbox user $1 (password $2) gets from the stream account's API: ok, auth (cannot log in
# yet) or imports (logged in, but the imports do not answer).
probe_user() {
  out=$(NATS_USER=$1 NATS_PASSWORD=$2 "$NATS" --inbox-prefix "_INBOX_$1" --timeout 2s request '$JS.API.INFO' '' 2>&1) || true
  case $out in
    *account_info_response*) echo ok ;;
    *uthoriz*) echo auth ;;
    *) echo imports ;;
  esac
}

# Wait until a new user can log in and reach the stream account through their imports; reload
# again (a few times at most) while they log in but their imports do not answer yet.
await_user() {
  i=0; extra=0
  while [ $i -lt 100 ]; do
    case $(probe_user "$1" "$2") in
      ok) return 0 ;;
      imports)
        pid=$(server_pid)
        if [ $extra -lt 3 ] && [ -n "$pid" ]; then
          extra=$((extra + 1))
          signal_reload "$pid" || true
          echo "reloaded nats-server again: $1's imports did not answer yet"
          sleep "$SETTLE"
        fi
        ;;
    esac
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

add_stream() {
  # $1 name, $2 subjects, then extra `nats stream add` flags. STREAM_AGE / STREAM_BYTES, when set,
  # replace the mailbox's retention and size cap.
  name=$1; subjects=$2; shift 2
  age=${STREAM_AGE:-$MAX_AGE}; bytes=${STREAM_BYTES:-$MAX_BYTES}
  if "$NATS" stream info "$name" >/dev/null 2>&1; then echo "stream $name already exists (kept)"; return; fi
  "$NATS" stream add "$name" --subjects "$subjects" --storage file --retention limits --discard old \
    --max-age "$age" --max-bytes "$bytes" --max-msgs=-1 --max-msgs-per-subject=-1 --max-msg-size=-1 \
    --dupe-window 2m --replicas 1 --allow-direct --deny-delete --deny-purge --no-allow-rollup \
    --description "agent-mailbox" "$@" --defaults >/dev/null
  echo "created stream $name ($subjects, file storage, max-age $age, max-bytes $bytes, discard old)"
}

# User $1's events stream. Its subject must be a wildcard: a stream on a literal subject counts as
# a listener for a push consumer's deliveries in the stream account (docs/PROTOCOL.md).
add_events_stream() {
  STREAM_AGE=$EVENTS_MAX_AGE; STREAM_BYTES=$EVENTS_MAX_BYTES
  add_stream "$(events_stream_of "$1")" "evt.$1.*"
  STREAM_AGE=; STREAM_BYTES=
}

# The sharing list clients read (key `team` of the sharing bucket): a JSON array of user names.
team_json() {
  tj_out=
  for tj_t in $(team_users); do tj_out="$tj_out${tj_out:+,}\"$tj_t\""; done
  printf '[%s]' "$tj_out"
}
# Retried for a few seconds: right after a reload the admin's own requests can fail briefly.
publish_sharing() {
  want=$(team_json)
  ps_i=0
  while [ $ps_i -lt 50 ]; do
    if have=$("$NATS" kv get sharing team --raw 2>/dev/null) && [ "$have" = "$want" ]; then return 0; fi
    if "$NATS" kv put sharing team "$want" >/dev/null 2>&1; then
      echo "sharing list updated: feeds shared with the team: $want"
      return 0
    fi
    ps_i=$((ps_i + 1)); sleep 0.1
  done
  die "could not write the sharing list (kv bucket sharing); run '$0 init' to retry"
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

# Does MBX_ALL republish the headers of each broadcast to the wake-up subjects? Users' accounts
# import those as mbx.all.* (NATS does not pass a message that arrived through a service import
# on to a stream export, so the broadcasts themselves cannot be the wake-up).
has_wake() {
  "$NATS" stream info MBX_ALL --json 2>/dev/null | tr -d ' \n\t' |
    grep -qF '"republish":{"src":"mbx.all.*","dest":"mbxwake.all.{{wildcard(1)}}","headers_only":true}'
}
# Does the presence bucket accept rollups? `nats kv add` allows them, and a rollup on any key, even
# a user's own, purges every entry in the bucket. The client only puts and deletes.
presence_rollup() {
  "$NATS" stream info KV_presence --json 2>/dev/null | tr -d ' \n\t' | grep -qF '"allow_rollup_hdrs":true'
}
check_base() {
  "$NATS" stream info MBX_ALL >/dev/null 2>&1 && has_wake && "$NATS" kv info presence >/dev/null 2>&1 &&
    ! presence_rollup && "$NATS" kv info sharing >/dev/null 2>&1 || return 1
  for cb_n in $(user_names); do
    "$NATS" stream info "$(events_stream_of "$cb_n")" >/dev/null 2>&1 || return 1
  done
}
ensure_base() {
  add_stream MBX_ALL 'mbx.all.*' --republish-source 'mbx.all.*' --republish-destination "$WAKE_DEST" --republish-headers
  if "$NATS" stream info MBX_ALL >/dev/null 2>&1 && ! has_wake; then
    "$NATS" stream edit MBX_ALL --republish-source 'mbx.all.*' --republish-destination "$WAKE_DEST" \
      --republish-headers -f >/dev/null
    echo "stream MBX_ALL now republishes broadcast headers to $WAKE (wake-ups)"
  fi
  if "$NATS" kv info presence >/dev/null 2>&1; then
    echo "kv bucket presence already exists (kept)"
  else
    "$NATS" kv add presence --history 1 --ttl "$PRESENCE_TTL" --storage file --replicas 1 >/dev/null
    echo "created kv bucket presence (history 1, ttl $PRESENCE_TTL)"
  fi
  if presence_rollup; then
    refuse_presence_rollup || die "could not make the presence bucket refuse rollups; check the server log and re-run"
    echo "kv bucket presence now refuses rollups (one would purge every user's entries)"
  fi
  if "$NATS" kv info sharing >/dev/null 2>&1; then
    echo "kv bucket sharing already exists (kept)"
  else
    "$NATS" kv add sharing --history 5 --storage file --replicas 1 >/dev/null
    echo "created kv bucket sharing (history 5; written only by the admin)"
  fi
  # Users provisioned before events feeds get theirs here.
  for eb_n in $(user_names); do add_events_stream "$eb_n"; done
}
# `nats stream edit` insists on a terminal to confirm editing a KV bucket's stream, so update the
# stream through the JetStream API: its current config with allow_rollup_hdrs turned off.
refuse_presence_rollup() {
  info=$("$NATS" request '$JS.API.STREAM.INFO.KV_presence' '' --raw 2>/dev/null) || return 1
  cfg=$(printf '%s' "$info" | sed -n 's/.*"config":\({.*}\),"created":.*/\1/p' |
    sed 's/"allow_rollup_hdrs":true/"allow_rollup_hdrs":false/')
  [ -n "$cfg" ] || return 1
  out=$("$NATS" request '$JS.API.STREAM.UPDATE.KV_presence' "$cfg" --raw 2>&1) || return 1
  case $out in *'"error"'*) echo "$out" >&2; return 1 ;; esac
  ! presence_rollup
}

# add-user's stream, named by $USER_NAME.
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

require_layout() {
  ! needs_upgrade || die "this configuration was written by an older mbox-admin.sh; run '$0 init' first to upgrade it to per-user accounts"
}

# ---------------------------------------------------------------- commands
# Idempotent, and safe to re-run after an interruption: a users.conf the running server has not
# reloaded yet is marked by users.conf.pending.
cmd_init() {
  umask 077
  mkdir -p "$USERS_DIR"
  if [ ! -f "$CREDS" ]; then
    pw=$(gen_password)
    h=$(bcrypt "$pw")
    user_block "$ADMIN_USER" "$h" >"$USERS_DIR/_admin.conf"
    printf 'user=%s\npassword=%s\n' "$ADMIN_USER" "$pw" >"$CREDS"
    chmod 600 "$CREDS" "$USERS_DIR/_admin.conf"
    echo "created admin user $ADMIN_USER (credentials in $CREDS, mode 0600)"
  fi
  migrate_users_d
  load_admin
  # Wake-ups first, so that users the reload below moves into their own accounts get them at once.
  up=0
  if server_up; then up=1; ensure_base; fi
  rebuild_users_conf
  reloaded=0
  if [ -f "$PENDING" ]; then
    if reload_server; then reloaded=1; wait_auth "$NATS_USER" "$NATS_PASSWORD" || true; fi
  else
    echo "users.conf unchanged: no server reload needed"
  fi
  if [ "$up" = 0 ]; then
    if ! server_up; then
      echo "server not reachable at $NATS_URL as $ADMIN_USER: start nats-server (see server/install.sh), then run '$0 init' again to create the streams."
      return 0
    fi
    ensure_base
  fi
  if [ "$reloaded" = 1 ]; then settle check_base ensure_base; fi
  publish_sharing
}

cmd_add_user() {
  name=$1; valid_name "$name"
  umask 077
  load_admin
  require_layout
  [ ! -f "$USERS_DIR/$name.conf" ] || die "user $name already exists (remove-user first to reset the password)"
  valid_sharing "$DEFAULT_SHARING"
  printf '%s\n' "$DEFAULT_SHARING" >"$USERS_DIR/$name.sharing"
  chmod 600 "$USERS_DIR/$name.sharing"
  pw=$(gen_password)
  h=$(bcrypt "$pw")
  user_block "$name" "$h" deny-all >"$USERS_DIR/$name.conf"
  chmod 600 "$USERS_DIR/$name.conf"
  rebuild_users_conf
  reload_server || die "user written to $USERS_DIR/$name.conf, but the server must be running to create the stream; start it and re-run add-user after remove-user"
  await_user "$name" "$pw" || die "the server did not give the new user their account after reloading; check its log"
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
  umask 077
  load_admin
  require_layout
  [ -f "$USERS_DIR/$name.conf" ] || die "no such user: $name"
  rm -f "$USERS_DIR/$name.conf" "$USERS_DIR/$name.sharing"
  rebuild_users_conf
  if reload_server; then reloaded=1; else reloaded=0; fi
  echo "removed user $name and their account (their connections are closed by the reload)"
  if [ "$reloaded" = 1 ]; then
    publish_sharing
  else
    echo "server not running: run '$0 init' once it runs, to update the sharing list"
  fi
  if [ "${2:-}" = "--delete-stream" ]; then
    "$NATS" stream rm -f "$(stream_of "$name")" >/dev/null && echo "deleted stream $(stream_of "$name") and its messages"
    "$NATS" stream rm -f "$(events_stream_of "$name")" >/dev/null 2>&1 &&
      echo "deleted stream $(events_stream_of "$name") and its events"
  else
    echo "kept streams $(stream_of "$name") and $(events_stream_of "$name") (mail ages out after $MAX_AGE, events after $EVENTS_MAX_AGE; pass --delete-stream to drop them now)"
  fi
}

cmd_set_sharing() {
  name=$1; valid_name "$name"; valid_sharing "$2"
  umask 077
  load_admin
  require_layout
  [ -f "$USERS_DIR/$name.conf" ] || die "no such user: $name"
  printf '%s\n' "$2" >"$USERS_DIR/$name.sharing"
  chmod 600 "$USERS_DIR/$name.sharing"
  rebuild_users_conf
  if [ -f "$PENDING" ]; then
    # The exports first: a feed made private stops being readable before the list says so.
    reload_server || die "sharing saved in $USERS_DIR/$name.sharing, but the server must be running to apply it; start it and run '$0 init'"
    publish_sharing
  else
    echo "users.conf unchanged: no server reload needed"
    if server_up; then publish_sharing; fi
  fi
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

cmd_permissions() {
  name=$1; valid_name "$name"
  echo "# What mailbox user '$name' may do (generated into users.conf; nothing is changed)."
  echo "# The stream account $STREAM_ACCOUNT exports these to $(account_of "$name") only:"
  user_exports "$name"
  echo "# and these to every user account:"
  shared_services | while read -r subj rt; do export_line "$subj" "$rt" '<every USER_ account>'; done
  printf '      { stream: "%s", accounts: [<every USER_ account>] }  # broadcast wake-ups\n' "$WAKE"
  echo "# $name's events feed ($(sharing_of "$name")), to these accounts, as users.d says now:"
  feed_export "$name"
  echo "# $name's own account, which holds no streams:"
  account_block "$name" '<bcrypt hash>'
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
  permissions) [ $# -ge 2 ] || usage; cmd_permissions "$2" ;;
  *) usage ;;
esac
