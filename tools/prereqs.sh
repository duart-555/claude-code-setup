#!/usr/bin/env bash
# Install the CLIs this setup leans on, from a clean machine. macOS (Homebrew) or Linux
# (apt/dnf/pacman). Idempotent: anything already present is skipped.
#
#   ./tools/prereqs.sh            # core + extras
#   ./tools/prereqs.sh --core     # only what gbrain / memory / skills need
#
# Exit code is non-zero when a CORE tool could not be installed. Extras only warn.
set -uo pipefail

CORE_ONLY=0; [ "${1:-}" = "--core" ] && CORE_ONLY=1
FAILED_CORE=(); FAILED_EXTRA=()
have() { command -v "$1" >/dev/null 2>&1; }
say()  { printf '\n== %s\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

# --- package manager -------------------------------------------------------------------------
PM=""
if have brew; then PM=brew
elif have apt-get; then PM=apt
elif have dnf; then PM=dnf
elif have pacman; then PM=pacman
fi
APT_UPDATED=0
pkg() {   # pkg <generic-name>...   install via the native manager, best effort
  case "$PM" in
    brew)   brew install "$@" ;;
    apt)    [ $APT_UPDATED = 0 ] && { $SUDO apt-get update -qq; APT_UPDATED=1; }
            $SUDO apt-get install -y -qq "$@" ;;
    dnf)    $SUDO dnf install -y -q "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    *)      return 1 ;;
  esac
}
# Generic name -> distro package name
pname() {
  case "$PM:$1" in
    apt:node|dnf:node) echo nodejs ;;
    apt:pipx) echo pipx ;;
    brew:node) echo node ;;
    pacman:node) echo nodejs ;;
    pacman:pipx) echo python-pipx ;;
    apt:rg|dnf:rg|pacman:rg) echo ripgrep ;;
    brew:rg) echo ripgrep ;;
    *) echo "$1" ;;
  esac
}
ensure() {   # ensure <binary> <generic-pkg> [core|extra]
  local bin="$1" name="$2" kind="${3:-extra}"
  have "$bin" && return 0
  [ -n "$PM" ] && pkg "$(pname "$name")" >/dev/null 2>&1
  have "$bin" && return 0
  if [ "$kind" = core ]; then FAILED_CORE+=("$bin"); else FAILED_EXTRA+=("$bin"); fi
  return 1
}
note_fail() {   # note_fail <bin> <kind>
  if [ "$2" = core ]; then FAILED_CORE+=("$1"); else FAILED_EXTRA+=("$1"); fi
}

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"

say "package manager: ${PM:-none found}"
[ -z "$PM" ] && echo "No brew/apt/dnf/pacman found; install base tools (curl git unzip zstd jq node npm python3 pipx) yourself, then re-run."

say "base tools"
for t in curl:curl git:git unzip:unzip zstd:zstd jq:jq python3:python3; do ensure "${t%%:*}" "${t##*:}" core; done
ensure pipx pipx extra || true
ensure node node extra || true
have npm || ensure npm npm extra || true

say "bun (gbrain needs 1.4.0+)"
if ! have bun; then curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; fi
export PATH="$HOME/.bun/bin:$PATH"; have bun && bun --version || note_fail bun core

say "gbrain (semantic code search / memory MCP)"
if ! have gbrain && have bun; then bun install -g github:garrytan/gbrain >/dev/null 2>&1; fi
have gbrain && gbrain --version 2>/dev/null | head -1 || note_fail gbrain core

say "ollama + mxbai-embed-large (local 1024-dim embeddings for gbrain)"
if ! have ollama; then
  if [ "$PM" = brew ]; then brew install ollama >/dev/null 2>&1
  else have zstd || ensure zstd zstd core; curl -fsSL https://ollama.com/install.sh | $SUDO sh >/dev/null 2>&1; fi
fi
if have ollama; then
  if ! ollama list >/dev/null 2>&1; then          # no server yet: start one for the pull
    if [ "$PM" = brew ] && brew services start ollama >/dev/null 2>&1; then :; else (nohup ollama serve >/dev/null 2>&1 &); fi
    for _ in $(seq 1 20); do ollama list >/dev/null 2>&1 && break; sleep 1; done
  fi
  ollama list 2>/dev/null | grep -q mxbai-embed-large || ollama pull mxbai-embed-large || FAILED_EXTRA+=("mxbai-embed-large")
else
  note_fail ollama core
fi

say "uv, then skillspector (install-time scanner for skills and MCP servers)"
if ! have uv; then curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; fi
export PATH="$HOME/.local/bin:$PATH"
if have uv; then
  have skillspector || uv tool install "skillspector[mcp] @ git+https://github.com/NVIDIA/skillspector.git" >/dev/null 2>&1
fi
have skillspector || note_fail skillspector core

if [ "$CORE_ONLY" = 0 ]; then
  say "pipx tools: caliper, code-review-graph, agent-reach and its platform CLIs"
  if have pipx; then
    pipx ensurepath >/dev/null 2>&1
    # <pipx spec>|<binary it installs>
    for t in "caliper-eval|caliper" "code-review-graph|code-review-graph" \
             "https://github.com/Panniantong/agent-reach/archive/main.zip|agent-reach" \
             "twitter-cli|twitter" "bilibili-cli|bili"; do
      spec="${t%%|*}"; bin="${t##*|}"
      have "$bin" || pipx install "$spec" >/dev/null 2>&1
      have "$bin" || note_fail "$bin" extra
    done
  else
    for b in caliper code-review-graph agent-reach twitter bili; do note_fail "$b(needs pipx)" extra; done
  fi

  say "node CLIs: opencli (agent-reach backend), mcporter, vercel"
  if have npm; then
    # avoid needing sudo for global installs
    [ -w "$(npm config get prefix 2>/dev/null)/lib" ] || npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1
    export PATH="$HOME/.npm-global/bin:$PATH"
    for t in opencli:@jackwener/opencli mcporter:mcporter vercel:vercel; do
      have "${t%%:*}" || npm install -g "${t##*:}" >/dev/null 2>&1
      have "${t%%:*}" || note_fail "${t%%:*}" extra
    done
  else
    for b in opencli mcporter vercel; do note_fail "$b(needs npm)" extra; done
  fi

  say "everyday CLIs: age (memory backup encryption), ripgrep, gh, yt-dlp"
  ensure age age extra || true
  ensure rg rg extra || true
  ensure gh gh extra || true
  have yt-dlp || { have pipx && pipx install yt-dlp >/dev/null 2>&1; } || true
  have yt-dlp || note_fail yt-dlp extra

  say "stripe CLI (only needed for the stripe plugin)"
  have stripe || { [ "$PM" = brew ] && brew install stripe/stripe-cli/stripe >/dev/null 2>&1; } || true
  have stripe || echo "skipped (optional): https://docs.stripe.com/stripe-cli"
fi

say "summary"
for c in bun gbrain ollama skillspector uv jq node npm pipx age caliper code-review-graph rg gh yt-dlp opencli mcporter vercel agent-reach twitter bili; do
  printf '  %-20s %s\n' "$c" "$(command -v "$c" || echo '-')"
done
if [ ${#FAILED_EXTRA[@]} -gt 0 ]; then printf '\noptional, not installed: %s\n' "${FAILED_EXTRA[*]}"; fi
if [ ${#FAILED_CORE[@]} -gt 0 ]; then
  printf '\nFAILED (core): %s\nFix those and re-run; this script is safe to repeat.\n' "${FAILED_CORE[*]}" >&2
  exit 1
fi
printf '\nAll core tools installed. Open a new shell (or `source ~/.bashrc`) so PATH changes apply.\n'
