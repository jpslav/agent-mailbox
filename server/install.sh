#!/bin/sh
# Prints (does NOT run) the steps to install the agent-mailbox NATS server as a service: launchd on
# macOS, systemd on Linux. Review the output, then run the steps yourself.
#
#   sh server/install.sh          the section for this OS
#   sh server/install.sh --all    both sections
#
# Environment overrides (each applies to the section(s) printed):
#   MBOX_CONF_DIR   config directory   [macOS: $(brew --prefix)/etc/agent-mailbox, Linux: /etc/agent-mailbox]
#   MBOX_STORE_DIR  JetStream store    [macOS: $(brew --prefix)/var/lib/nats,        Linux: /var/lib/agent-mailbox]
#   MBOX_RUN_DIR    pid file directory [macOS: $(brew --prefix)/var/run/agent-mailbox, Linux: /run/agent-mailbox]
#   MBOX_LOG_DIR    macOS log directory [$(brew --prefix)/var/log]
#   NATS_SERVER_BIN nats-server path   [macOS: <brew prefix>/bin/nats-server, Linux: /usr/local/bin/nats-server]
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)

case ${1:-} in
  '') case $(uname -s) in Darwin) mode=macos ;; Linux) mode=linux ;; *) mode=all ;; esac ;;
  --all) mode=all ;;
  --macos) mode=macos ;;
  --linux) mode=linux ;;
  *) echo "usage: sh server/install.sh [--all | --macos | --linux]" >&2; exit 2 ;;
esac

print_macos() {
  prefix=
  if command -v brew >/dev/null 2>&1; then prefix=$(brew --prefix 2>/dev/null) || prefix=; fi
  : "${prefix:=/opt/homebrew}"   # Apple Silicon default, used when brew is not installed here
  CONF_DIR=${MBOX_CONF_DIR:-$prefix/etc/agent-mailbox}
  STORE_DIR=${MBOX_STORE_DIR:-$prefix/var/lib/nats}
  RUN_DIR=${MBOX_RUN_DIR:-$prefix/var/run/agent-mailbox}
  LOG_FILE=${MBOX_LOG_DIR:-$prefix/var/log}/agent-mailbox-nats.log
  BIN=${NATS_SERVER_BIN:-$prefix/bin/nats-server}
  LABEL=org.agent-mailbox.nats-server
  PLIST="\$HOME/Library/LaunchAgents/$LABEL.plist"
  cat <<EOF2
# ---------------------------------------------------------------------------------------------
# agent-mailbox server install: macOS (Homebrew + launchd). Nothing below has been run.
# ---------------------------------------------------------------------------------------------

# 1. Binaries: nats-server >= 2.11 and the nats CLI (used by mbox-admin.sh)
brew install nats-server nats-io/nats-tools/nats

# 2. Config + data directories, and the config (pid_file and store_dir are filled in for you)
mkdir -p "$CONF_DIR" "$STORE_DIR" "$RUN_DIR"
chmod 700 "$CONF_DIR" "$STORE_DIR"
sed -e 's|^pid_file:.*|pid_file: "$RUN_DIR/nats-server.pid"|' \\
    -e 's|^\\([[:space:]]*\\)store_dir:.*|\\1store_dir: "$STORE_DIR"|' \\
    "$here/nats-server.conf.example" > "$CONF_DIR/nats-server.conf"
#    Edit $CONF_DIR/nats-server.conf: set 'listen' to this host's tailnet IP (100.x.y.z:4222).

# 3. Admin user + users.conf (the server cannot start without users.conf)
MBOX_CONF_DIR="$CONF_DIR" "$here/mbox-admin.sh" init

# 4. Validate the config
"$BIN" -c "$CONF_DIR/nats-server.conf" -t

# 5. launchd agent (runs as you, starts at login, restarts on crash). Use this rather than
#    'brew services start nats-server', which would start nats-server WITHOUT this config.
mkdir -p "\$HOME/Library/LaunchAgents" "\$(dirname "$LOG_FILE")"
sed -e 's|@LABEL@|$LABEL|g' \\
    -e 's|@NATS_SERVER_BIN@|$BIN|g' \\
    -e 's|@CONF_DIR@|$CONF_DIR|g' \\
    -e 's|@LOG_FILE@|$LOG_FILE|g' \\
    "$here/launchd/$LABEL.plist.template" > "$PLIST"
launchctl bootstrap "gui/\$(id -u)" "$PLIST"
launchctl print "gui/\$(id -u)/$LABEL" | head -20      # check it is running
#    (A LaunchAgent runs only while you are logged in; for a headless host see the comment at the
#    top of the plist template.)

# 6. Streams + presence bucket, then your first user
MBOX_CONF_DIR="$CONF_DIR" "$here/mbox-admin.sh" init
MBOX_CONF_DIR="$CONF_DIR" MBOX_PUBLIC_URL=nats://100.x.y.z:4222 "$here/mbox-admin.sh" add-user alice

# Reload users/config without dropping connections:  "$BIN" --signal reload=\$(cat "$RUN_DIR/nats-server.pid")
# Restart:  launchctl kickstart -k "gui/\$(id -u)/$LABEL"
# Stop / uninstall:
#   launchctl bootout "gui/\$(id -u)/$LABEL" && rm "$PLIST"
EOF2
}

print_linux() {
  CONF_DIR=${MBOX_CONF_DIR:-/etc/agent-mailbox}
  STORE_DIR=${MBOX_STORE_DIR:-/var/lib/agent-mailbox}
  BIN=${NATS_SERVER_BIN:-/usr/local/bin/nats-server}
  UNIT=agent-mailbox-nats.service
  if [ "$BIN $CONF_DIR $STORE_DIR" = "/usr/local/bin/nats-server /etc/agent-mailbox /var/lib/agent-mailbox" ]; then
    UNIT_CMD="sudo install -m 644 \"$here/systemd/$UNIT\" /etc/systemd/system/$UNIT"
  else
    # Non-default locations: the unit file names the default ones, so rewrite them on the way in.
    UNIT_CMD="sed -e 's|/usr/local/bin/nats-server|$BIN|g' \\
    -e 's|/etc/agent-mailbox|$CONF_DIR|g' \\
    -e 's|/var/lib/agent-mailbox|$STORE_DIR|g' \\
    \"$here/systemd/$UNIT\" | sudo tee /etc/systemd/system/$UNIT >/dev/null"
  fi
  cat <<EOF2
# ---------------------------------------------------------------------------------------------
# agent-mailbox server install: Linux (systemd). Nothing below has been run.
# ---------------------------------------------------------------------------------------------

# 1. Binaries: nats-server >= 2.11 and the nats CLI (used by mbox-admin.sh), e.g. release
#    binaries from https://github.com/nats-io/nats-server/releases and
#    https://github.com/nats-io/natscli/releases, or your distro's packages if they are new enough.
#    Put them in /usr/local/bin (the unit file expects nats-server at $BIN).
nats-server --version && nats --version

# 2. Service user, directories (the unit creates /run/agent-mailbox for the pid file itself)
sudo useradd --system --home-dir "$STORE_DIR" --shell /usr/sbin/nologin agent-mailbox
sudo install -d -o agent-mailbox -g agent-mailbox -m 700 "$CONF_DIR" "$STORE_DIR"

# 3. Config (pid_file and store_dir are filled in for you)
sed -e 's|^pid_file:.*|pid_file: "/run/agent-mailbox/nats-server.pid"|' \\
    -e 's|^\\([[:space:]]*\\)store_dir:.*|\\1store_dir: "$STORE_DIR"|' \\
    "$here/nats-server.conf.example" | sudo -u agent-mailbox tee "$CONF_DIR/nats-server.conf" >/dev/null
#    Edit $CONF_DIR/nats-server.conf: set 'listen' to this host's tailnet IP (100.x.y.z:4222).

# 4. Admin user + users.conf (the server cannot start without users.conf). mbox-admin.sh must run
#    as the service user so the files it writes are readable by the server; that user needs
#    to be able to read the script, so install a copy (it needs the nats CLI on PATH as well).
sudo install -m 755 "$here/mbox-admin.sh" /usr/local/bin/mbox-admin.sh
sudo -u agent-mailbox env MBOX_CONF_DIR="$CONF_DIR" /usr/local/bin/mbox-admin.sh init

# 5. Validate the config, install and start the unit
sudo -u agent-mailbox "$BIN" -c "$CONF_DIR/nats-server.conf" -t
$UNIT_CMD
sudo systemctl daemon-reload
sudo systemctl enable --now agent-mailbox-nats
systemctl status agent-mailbox-nats --no-pager

# 6. Streams + presence bucket, then your first user
sudo -u agent-mailbox env MBOX_CONF_DIR="$CONF_DIR" /usr/local/bin/mbox-admin.sh init
sudo -u agent-mailbox env MBOX_CONF_DIR="$CONF_DIR" MBOX_PUBLIC_URL=nats://100.x.y.z:4222 /usr/local/bin/mbox-admin.sh add-user alice

# Reload config after editing it by hand:  sudo systemctl reload agent-mailbox-nats
# Logs:  journalctl -u agent-mailbox-nats
# Stop / uninstall:
#   sudo systemctl disable --now agent-mailbox-nats && sudo rm /etc/systemd/system/$UNIT
EOF2
}

case $mode in
  macos) print_macos ;;
  linux) print_linux ;;
  all) print_macos; echo; print_linux ;;
esac
