#!/usr/bin/env bash
# Vendors the portable subset of the harness into a project repo's own .claude/
# folder, so Cloud Code sessions (which only ever see the repo they're attached
# to, never ~/.claude globally) get the same agents/rules as local sessions.
#
# What travels: agent definitions with no local-process dependency, and a
# curated rules digest appended into the project's own CLAUDE.md (not a
# project-level rules/ folder — that auto-load path isn't confirmed to exist,
# CLAUDE.md at project root definitely is read everywhere).
#
# What never travels: anything needing Ollama/local SQLite/Chrome/local trading
# creds — those can't run in a cloud sandbox regardless of what's vendored.
set -euo pipefail

TARGET="${1:?Usage: sync-claude-config.sh <path-to-project-repo>}"
HARNESS="$HOME/.claude"
MARKER_START="<!-- claude-harness:vendored:start -->"
MARKER_END="<!-- claude-harness:vendored:end -->"

if [ ! -d "$TARGET/.git" ]; then
  echo "FAIL: $TARGET is not a git repo" >&2
  exit 1
fi

# Portable agents — generally useful reviewers/specialists with no local-tool
# dependency. Deliberately excludes gsd-*, caveman-*, and anything tied to
# this machine's specific plugin install.
AGENTS=(
  code-reviewer security-reviewer typescript-reviewer python-reviewer
  tdd-guide planner architect database-reviewer react-reviewer
  performance-optimizer silent-failure-hunter
)

mkdir -p "$TARGET/.claude/agents"
copied=0
for a in "${AGENTS[@]}"; do
  if [ -f "$HARNESS/agents/$a.md" ]; then
    cp "$HARNESS/agents/$a.md" "$TARGET/.claude/agents/$a.md"
    copied=$((copied + 1))
  fi
done
echo "vendored $copied/${#AGENTS[@]} agents into $TARGET/.claude/agents/"

# Memory generator — self-contained (zero npm deps, just node:fs/node:path/node:os/
# node:child_process/node:url), so it's portable to vendor as-is. Without this, a
# cloud session can read this project's embedded .claude/memory/ but has no way to
# validate or rebuild MEMORY.md after writing a new fact file.
if [ -f "$HARNESS/scripts/memory-index.mjs" ]; then
  mkdir -p "$TARGET/.claude/scripts"
  cp "$HARNESS/scripts/memory-index.mjs" "$TARGET/.claude/scripts/memory-index.mjs"
  echo "vendored memory-index.mjs into $TARGET/.claude/scripts/"
fi

# Rules digest — appended into the project's own CLAUDE.md inside markers, so
# re-running this script updates the digest in place instead of duplicating it.
DIGEST_SRC=(
  "$HARNESS/rules/ecc/common/coding-style.md"
  "$HARNESS/rules/ecc/common/testing.md"
  "$HARNESS/rules/ecc/common/security.md"
  "$HARNESS/rules/ecc/common/code-review.md"
  "$HARNESS/rules/ecc/common/proactive-tool-use.md"
  "$HARNESS/rules/ecc/common/cloud-memory-write.md"
)

TARGET_CLAUDE_MD="$TARGET/CLAUDE.md"
touch "$TARGET_CLAUDE_MD"

tmp=$(mktemp)
awk -v start="$MARKER_START" -v end="$MARKER_END" '
  $0 == start { skip=1 }
  !skip { print }
  $0 == end { skip=0 }
' "$TARGET_CLAUDE_MD" > "$tmp"

{
  # Strip trailing blank lines before re-adding exactly one separator — without
  # this, re-running the script accumulates a blank line every time (command
  # substitution strips trailing newlines, so this is the cheap fix).
  printf '%s\n' "$(cat "$tmp")"
  echo ""
  echo "$MARKER_START"
  echo "<!-- Vendored from the personal harness repo — do not hand-edit, re-run sync-claude-config.sh instead -->"
  for f in "${DIGEST_SRC[@]}"; do
    [ -f "$f" ] && { echo ""; cat "$f"; }
  done
  echo ""
  echo "$MARKER_END"
} > "$TARGET_CLAUDE_MD"
rm -f "$tmp"

echo "rules digest written into $TARGET_CLAUDE_MD (between markers, idempotent)"

# Register this project's embedded memory with the local archiver — machine-local
# state (absolute paths differ per machine), never committed to claude-harness.
# Without this, memory-autoarchive.mjs only ever sees the default
# ~/.claude/projects/*/memory/ layout and silently never touches embedded corpora.
if [ -d "$TARGET/.claude/memory" ]; then
  REGISTRY="$HARNESS/embedded-memory-projects.txt"
  REAL_TARGET="$(cd "$TARGET" && pwd)"
  touch "$REGISTRY"
  grep -qxF "$REAL_TARGET" "$REGISTRY" || echo "$REAL_TARGET" >> "$REGISTRY"
  echo "registered $REAL_TARGET in $REGISTRY for weekly auto-archiving"
fi

echo ""
echo "Next: cd $TARGET && git add .claude CLAUDE.md && git commit -m 'vendor harness config subset for Cloud Code parity'"
