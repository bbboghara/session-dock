#!/usr/bin/env bash
# Installs Session Dock as a systemd *user* service (no sudo needed) and starts it.
# Run it again after moving this folder or changing Node versions.
#
#   ./install.sh              install or update, then start
#   ./install.sh --reset-pin  forgot the PIN? choose a new one (signs out every device)
#   ./install.sh --uninstall  stop and remove the service (your data/ folder is kept)
set -euo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
UNIT=session-dock.service
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not as root or with sudo."
command -v systemctl >/dev/null || die "systemd is required."
systemctl --user show-environment >/dev/null 2>&1 ||
  die "your systemd user session is not reachable. Run this from a normal login (desktop terminal or SSH), not via su/sudo."

case "${1-}" in '' | --uninstall | --reset-pin) ;; *) die "unknown option: $1" ;; esac

if [ "${1-}" = --uninstall ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f -- "$UNIT_DIR/$UNIT"
  systemctl --user daemon-reload
  say "Session Dock service removed. Open Claude windows keep running; $APP_DIR/data was kept."
  exit 0
fi

case "$APP_DIR" in *[\"\\$'\n']*) die "the folder path must not contain quotes, backslashes or newlines: $APP_DIR" ;; esac

# Node 22+. fnm, nvm and Volta put a per-shell link or launcher first on PATH, so ask Node for the real program.
NODE=${SD_NODE:-$(command -v node || true)}
[ -n "$NODE" ] || die "Node.js 22 or newer is required (https://nodejs.org, or a version manager like fnm)."
NODE=$("$NODE" -p process.execPath) || die "could not run $NODE."
major=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "Node.js 22 or newer is required (found $("$NODE" --version))."

command -v systemd-run >/dev/null || die "systemd-run is required."
command -v tmux >/dev/null || warn "tmux is not installed: approving a brand-new folder for Claude from the app will not work."

if [ ! -f "$APP_DIR/.env" ]; then
  cp -- "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 -- "$APP_DIR/.env"
  say "Created $APP_DIR/.env (settings; edit it and run ./install.sh again to apply)."
fi

# Last value of KEY in .env, without quotes (or $2 if unset).
envval() {
  local v
  v=$(sed -n "s/^[[:space:]]*$1=//p" "$APP_DIR/.env" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "${v:-$2}"
}
PORT=$(envval SD_PORT 50760)
# Where to reach the service from here. An address that means "every interface" isn't one to connect to.
HOST=$(envval SD_HOST 127.0.0.1)
case "$HOST" in 0.0.0.0 | ::) HOST=127.0.0.1 ;; *:*) HOST="[$HOST]" ;; esac

# The service doesn't read your shell's setup, so it finds only ~/.local/bin/claude
# and the standard folders. A Claude from npm or a version manager needs telling.
if [ ! -x "$HOME/.local/bin/claude" ] && [ -z "$(envval SD_CLAUDE_BIN '')" ]; then
  found=$(command -v claude || true)
  if [ -z "$found" ]; then
    warn "Claude Code was not found. Install it, or set SD_CLAUDE_BIN in .env."
  else
    # Named by its real folder: fnm's link on PATH lasts only as long as your shell.
    found=$(cd -P -- "$(dirname -- "$found")" && pwd -P)/claude
    warn "Claude Code is at $found, where the service may not find it. If windows don't start Claude, add SD_CLAUDE_BIN=$found to .env."
  fi
fi

DATA_DIR=$(envval SD_DATA_DIR "$APP_DIR/data")
case "$DATA_DIR" in /*) ;; *) DATA_DIR=$APP_DIR/$DATA_DIR ;; esac

# The PIN reaches the helper on stdin, so it never shows up on a command line.
pin_helper() { SD_DATA_DIR=$DATA_DIR "$NODE" "$APP_DIR/bin/set-pin.js" "$@"; }

# Asks for a PIN twice, hidden, until it is one the app accepts. Leaves it in $PIN.
ask_pin() {
  local again
  while :; do
    read -rs -p 'Choose a PIN for Session Dock (6 to 12 digits): ' PIN
    echo
    read -rs -p 'Type it again: ' again
    echo
    if [ "$PIN" != "$again" ]; then
      say "The two PINs don't match."
      continue
    fi
    printf '%s\n' "$PIN" | pin_helper --check && return 0
  done
}

if [ "${1-}" = --reset-pin ]; then
  [ -t 0 ] || die "--reset-pin asks for the new PIN, so run it in a terminal."
  ask_pin
  # Stopped first: a running service keeps the old PIN in memory and would write it back.
  systemctl --user stop "$UNIT" 2>/dev/null || true
  printf '%s\n' "$PIN" | pin_helper
  say "PIN changed. Every device has been signed out."
  systemctl --user start "$UNIT" 2>/dev/null || say "The service isn't installed yet. Run ./install.sh to start it."
  exit 0
fi

# First install in a terminal: you choose the PIN. Otherwise (from a script, for
# example) the app makes a temporary one and won't work until you replace it.
if [ ! -f "$DATA_DIR/auth.json" ] && [ -t 0 ]; then
  ask_pin
  printf '%s\n' "$PIN" | pin_helper
fi

# systemd treats "%" as a specifier, so double it in paths.
p() { printf '%s' "${1//%/%%}"; }
mkdir -p -- "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT" <<EOF
# Written by install.sh in $APP_DIR. Run it again instead of editing this file.
[Unit]
Description=Session Dock (Claude Code sessions on your desktop, from any browser)

[Service]
WorkingDirectory=$(p "$APP_DIR")
EnvironmentFile=-$(p "$APP_DIR")/.env
ExecStart="$(p "$NODE")" "$(p "$APP_DIR")/server.js"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"

ok=
for _ in $(seq 1 20); do
  if "$NODE" -e "fetch('http://$HOST:$PORT/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  sleep 0.5
done
[ -n "$ok" ] || die "the service did not start. See: journalctl --user -u session-dock -n 50"

say ""
say "Session Dock is running on http://$HOST:$PORT."
if [ -f "$DATA_DIR/first-run-pin.txt" ]; then
  say "Temporary PIN: $(cat -- "$DATA_DIR/first-run-pin.txt")"
  say "Sign in with it and you'll be asked to choose your own. Nothing else works until you do."
fi
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
  say ""
  say "To keep it running after you log out, and start it at boot, run once:"
  say "  sudo loginctl enable-linger $USER"
fi
say ""
say "To use it from your phone or another computer, put it behind a PRIVATE HTTPS"
say "address. With Tailscale (tailnet only, not public):"
say "  sudo tailscale serve --bg --https=$((PORT + 1)) http://$HOST:$PORT"
say "See README.md for details and the security notes."
