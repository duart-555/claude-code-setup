# Security

This repository configures an AI coding agent. Installing it means running code from this repo on
your machine with your user's permissions, so read before you trust.

## What runs on your machine

- **Hooks** (`hooks/`, `scripts/`, wired up in `settings.json`) execute Node and shell scripts on
  Claude Code events: before and after tool calls, at session start and end, on failures.
- **`install.sh` and `tools/*.sh`** copy files into `~/.claude`, add plugin marketplaces, install
  plugins and CLIs, and (optionally) start a Docker container and launchd jobs.
- **Plugins and MCP servers** are installed from third-party sources listed in `plugins.txt` and
  `mcp-servers.json`. They are not reviewed or controlled by this repo.

Run `./install.sh --dry-run` first, skim `settings.json` and the hooks you care about, and trim
`plugins.txt` to what you actually use.

## What this repo does not contain

No API keys, tokens, hostnames or personal data. Credentials are `<YOUR_...>` placeholders; the
installer skips any MCP server that still has one. `.gitleaks.toml` and a CI workflow scan every
push. If you find a secret or personal identifier anyway, treat it as a bug and report it.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting:
**Security tab > Report a vulnerability**. Include what you found, where, and how to reproduce it.
Fixes for confirmed issues, including leaked secrets, are prioritised over everything else.

## Scope notes

- Third-party skills, plugins and agents keep their upstream licenses and security posture; report
  issues in them upstream. See `THIRD_PARTY_LICENSES.md` and `SKILLS.md`.
- Four skills have no confirmed license (`SKILLS.md`). If you are their author and want one
  removed, open an issue.
