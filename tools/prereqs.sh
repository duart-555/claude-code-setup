#!/usr/bin/env bash
# Install the CLIs the setup leans on. Idempotent; skips what is present. macOS or Linux.
set -uo pipefail
have() { command -v "$1" >/dev/null 2>&1; }
say() { printf '\n== %s\n' "$*"; }

say "bun (needed by gbrain, 1.4.0+ recommended)"
have bun || curl -fsSL https://bun.sh/install | bash

say "gbrain (semantic code search / memory MCP)"
have gbrain || bun install -g github:garrytan/gbrain

say "ollama + mxbai-embed-large (local embeddings for gbrain, 1024-dim, free)"
if ! have ollama; then
  if have brew; then brew install ollama; else curl -fsSL https://ollama.com/install.sh | sh; fi
fi
have ollama && ollama pull mxbai-embed-large

say "skillspector (install-time scanner for skills/MCP servers)"
have skillspector || { have uv && uv tool install "skillspector[mcp] @ git+https://github.com/NVIDIA/skillspector.git"; }

say "caliper (measures whether a skill earns its token cost)"
have caliper || { have pipx && pipx install caliper-eval; }

say "code-review-graph (per-project code graph; run 'code-review-graph install --platform claude-code' in a repo)"
have code-review-graph || { have pipx && pipx install code-review-graph; }

say "age (encrypts memory backups)"
have age || { have brew && brew install age; } || echo "install age from your package manager"

say "ollama as a login service (macOS/Homebrew)"
have brew && have ollama && brew services start ollama >/dev/null 2>&1 || true

say "everyday CLIs used by skills and hooks (ripgrep, yt-dlp, gh, jq)"
for t in rg:ripgrep yt-dlp:yt-dlp gh:gh jq:jq; do
  have "${t%%:*}" || { have brew && brew install "${t##*:}"; } || echo "install ${t##*:} from your package manager"
done

say "node-based CLIs: opencli (agent-reach backend), mcporter, vercel"
if have npm; then
  have opencli  || npm install -g @jackwener/opencli
  have mcporter || npm install -g mcporter
  have vercel   || npm install -g vercel
fi

say "agent-reach and its platform CLIs (credentials are yours to add; see the skill)"
if have pipx; then
  have agent-reach  || pipx install agent-reach
  have twitter-cli  || pipx install twitter-cli
  have bilibili-cli || pipx install bilibili-cli
fi

say "stripe CLI (only if you use the stripe plugin)"
have stripe || { have brew && brew install stripe/stripe-cli/stripe; } || true

say "done"
for c in bun gbrain ollama skillspector caliper code-review-graph age jq node gh rg yt-dlp opencli mcporter vercel agent-reach; do
  printf '%-20s %s\n' "$c" "$(command -v "$c" || echo MISSING)"
done
