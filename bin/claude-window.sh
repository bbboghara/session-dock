#!/usr/bin/env bash
# Runs inside a desktop terminal window opened by Session Dock.
#
# It starts Claude with Remote Control on. When the web app asks for a
# restart, the app writes an "action" file and stops Claude; this loop then
# starts Claude again IN THE SAME WINDOW (resuming the same conversation, on
# the newest installed Claude version). On "close" the window closes.
#
# Usage: claude-window.sh <control-dir> <folder> <new|resume> <session-id> [name]
set -u
CTL=$1
CWD=$2
MODE=$3
SID=$4
NAME=${5-}

CLAUDE=${SD_CLAUDE_BIN-}
[ -x "$CLAUDE" ] || CLAUDE=$HOME/.local/bin/claude
[ -x "$CLAUDE" ] || CLAUDE=claude
unset SD_CLAUDE_BIN

# Some terminals run on a private D-Bus of their own; give Claude the desktop's.
if [ -n "${SD_DESKTOP_DBUS-}" ]; then
  export DBUS_SESSION_BUS_ADDRESS=$SD_DESKTOP_DBUS
fi
unset SD_DESKTOP_DBUS

mkdir -p -- "$CTL"
echo $$ > "$CTL/wrapper.pid"
printf '%s\n' "${WINDOWID-}" > "$CTL/windowid"
trap 'rm -rf -- "$CTL"' EXIT

cd -- "$CWD" || { echo "Folder not found: $CWD"; read -r -p "Press Enter to close." _; exit 1; }

while :; do
  rm -f -- "$CTL/action"
  if [ "$MODE" = resume ]; then
    args=(--resume "$SID")
  else
    args=(--session-id "$SID")
  fi
  if [ -n "$NAME" ]; then
    # Joined with "=", so a name can never be read as an option of its own.
    args+=("--name=$NAME" "--remote-control=$NAME")
  else
    args+=(--remote-control)
  fi
  title=${NAME:-${CWD##*/}}
  printf '\033]0;%s\007' "Claude · ${title//[[:cntrl:]]/ }"

  "$CLAUDE" "${args[@]}"
  code=$?

  if [ -f "$CTL/action" ]; then
    { read -r act; read -r MODE; read -r SID; read -r NAME; } < "$CTL/action"
    case "$act" in
      restart)
        printf '\n\033[1m↻ Restarting Claude (same conversation)…\033[0m\n\n'
        continue
        ;;
      close) exit 0 ;;
    esac
  fi

  if [ "$code" -ne 0 ]; then
    # Tells the web app, so this window can be retried or closed from there too.
    printf '%s\n%s\n%s\n' "$code" "$SID" "$NAME" > "$CTL/exited"
    printf '\nClaude exited (code %s). Press Enter to close this window.\n' "$code"
    read -r _
  fi
  exit 0
done
