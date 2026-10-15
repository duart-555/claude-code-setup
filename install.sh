#!/usr/bin/env bash
# Install this Claude Code setup into ~/.claude. Idempotent; never overwrites without a backup.
#   ./install.sh            copy files, register marketplaces, install plugins, add keyless MCP servers
#   ./install.sh --dry-run  print what would happen
#   ./install.sh --no-plugins | --no-mcp   skip a stage
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DRY=0; DO_PLUGINS=1; DO_MCP=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-plugins) DO_PLUGINS=0 ;;
    --no-mcp) DO_MCP=0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
need jq; need node
[ "$DO_PLUGINS$DO_MCP" = "00" ] || need claude

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DEST/backup-before-setup-$STAMP"

# 1. Files. Existing files are backed up, then replaced; anything not in this repo is left alone.
echo "== files -> $DEST"
for d in agents hooks rules commands contexts scripts skills; do
  [ -d "$HERE/$d" ] || continue
  run mkdir -p "$DEST/$d"
  if [ -d "$DEST/$d" ] && [ "$(ls -A "$DEST/$d" 2>/dev/null | wc -l)" -gt 0 ]; then
    run mkdir -p "$BACKUP/$d"; run cp -Rp "$DEST/$d/." "$BACKUP/$d/"
  fi
  run cp -Rp "$HERE/$d/." "$DEST/$d/"
done

# 2. settings.json: never clobber an existing one; drop ours beside it for a manual merge.
if [ -f "$DEST/settings.json" ]; then
  run cp "$HERE/settings.json" "$DEST/settings.json.from-setup"
  echo "settings.json exists -> wrote settings.json.from-setup; merge by hand (plugins, hooks, deny rules)"
else
  run cp "$HERE/settings.json" "$DEST/settings.json"
fi
[ -f "$DEST/CLAUDE.md" ] && echo "CLAUDE.md exists -> left untouched; see CLAUDE.md.example" \
  || run cp "$HERE/CLAUDE.md.example" "$DEST/CLAUDE.md"

# 3. Marketplaces + plugins.
if [ "$DO_PLUGINS" = 1 ]; then
  echo "== marketplaces"
  jq -r '.extraKnownMarketplaces | to_entries[] | (.value.source.repo // .value.source.url)' "$HERE/settings.json" |
    while read -r src; do run claude plugin marketplace add "$src" || echo "  (skip $src)"; done
  # claude-mem is not in extraKnownMarketplaces; it is listed explicitly in plugins.txt.
  run claude plugin marketplace add thedotmack/claude-mem || true
  echo "== plugins"
  grep -v '^#' "$HERE/plugins.txt" | grep -v '^$' |
    while read -r p; do run claude plugin install "$p" || echo "  (skip $p)"; done
fi

# 4. MCP servers. Entries still holding a <YOUR_...> placeholder need a key first and are skipped.
if [ "$DO_MCP" = 1 ]; then
  echo "== MCP servers (user scope)"
  jq -r '.mcpServers | to_entries[] | [.key, (.value|tojson)] | @tsv' "$HERE/mcp-servers.json" |
    while IFS=$'\t' read -r name json; do
      if printf '%s' "$json" | grep -q '<YOUR_'; then
        echo "  - $name: needs a credential -> edit mcp-servers.json, then: claude mcp add-json $name '<json>' -s user"
        continue
      fi
      json="${json//\$HOME/$HOME}"
      run claude mcp add-json "$name" "$json" -s user || echo "  (skip $name)"
    done
fi

echo "done. Next: ./tools/prereqs.sh (CLIs), optionally ./tools/install-schedules.sh. Restart Claude Code. Backups: $BACKUP"
