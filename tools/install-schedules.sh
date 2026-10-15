#!/usr/bin/env bash
# macOS only: install the launchd jobs (weekly memory backup + archive, daily health, nightly gbrain dream).
set -euo pipefail
[ "$(uname)" = Darwin ] || { echo "launchd is macOS only; use cron on Linux (see launchd/*.plist for the schedule)"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)/launchd"; DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST" "$HOME/.claude/logs"
for p in "$SRC"/*.plist; do
  n="$(basename "$p")"; sed "s#__HOME__#$HOME#g" "$p" > "$DEST/$n"
  launchctl bootout "gui/$(id -u)/${n%.plist}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$DEST/$n" && echo "loaded ${n%.plist}"
done
echo "Memory backup needs ~/.claude/.env.memory-backup (start from env.memory-backup.example). Jobs no-op without it."
