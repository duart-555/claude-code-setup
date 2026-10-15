# Claude Code setup

A complete, working [Claude Code](https://claude.com/claude-code) configuration, exported from a
daily-driver machine: 61 agents, 154 skills, 29 plugins, 9 MCP servers, hooks, rules, slash
commands, a file-based memory system with scheduled maintenance, and hardened settings.

Clone it, run the installer, restart Claude Code.

No secrets, API keys, hostnames or personal data are in this repo. Every credential is a
`<YOUR_...>` placeholder.

## Quick start

```bash
git clone https://github.com/<you>/claude-code-setup.git && cd claude-code-setup
./install.sh --dry-run        # show what it will do
./install.sh                  # files + marketplaces + plugins + keyless MCP servers
./tools/prereqs.sh            # CLIs: bun, gbrain, ollama(+embeddings), skillspector, caliper, ...
./tools/install-schedules.sh        # optional, macOS: memory backup/archive/health jobs
```

Needs `jq`, `node` 20+, `git` and the `claude` CLI. The installer backs up what it replaces to
`~/.claude/backup-before-setup-<timestamp>/`, never overwrites an existing `settings.json` or
`CLAUDE.md` (it writes `settings.json.from-setup` and leaves `CLAUDE.md.example` for you to merge).

Flags: `--dry-run`, `--no-plugins`, `--no-mcp`.

## What is in here

| Path | Contents |
|---|---|
| `agents/` | 61 subagents: planner, architect, code / security / database / language reviewers, build resolvers, TDD guide, and the `gsd-*` phase agents |
| `skills/` | 154 skills: 48 engineering (ECC), 71 `gsd-*`, 13 design-taste, 6 web-quality, 3 Caliper, `last30days`, `ui-ux-pro-max`, `stop-slop`, anti-slop, 5 hand-authored (brainstorming, systematic-debugging, verification-before-completion, receiving-code-review, memory-audit), and 4 **without a confirmed upstream license** (see `SKILLS.md`) |
| `hooks/`, `scripts/` | Hook implementations and libraries: dash-path guard, memory auto-capture, recall-on-failure, session tracking, quality gates, memory generator/backup/archive with tests |
| `rules/` | Always-on rules: coding style, testing, security, git workflow, review standards |
| `commands/` | 23 slash commands |
| `settings.json` | Hooks, enabled plugins, 11 marketplaces, skill overrides, deny rules. No personal allow-list |
| `plugins.txt` | 29 plugins: caveman, chisle, claude-mem, context-mode, reticle, superpowers, vercel, stripe, ui-ux-pro-max, marketing-skills, and the Knowledge-Work set (productivity, product-management, engineering, data, design, marketing, sales, legal, finance, operations, support, enterprise-search, small-business, product-tracking) |
| `mcp-servers.json` | context7, playwright, gbrain, greptile, mobbin, magic, skillspector, gitmcp, c4ai-sse |
| `CLAUDE.md.example` | Portable global instructions (no personal content): memory layers, 95% rule, effort triage, GSD vs superpowers, agent/MCP triage, memory contract |
| `launchd/` | macOS job templates: weekly memory backup + archive, daily health report, nightly gbrain consolidation |
| `evals/` | Caliper spec for the chisle skill |
| `tools/` | `prereqs.sh`, `install-schedules.sh` |

## The memory system

`scripts/memory-index.mjs` implements a small durable-memory contract: one fact per file, a
generated index, `verify_by` dates, archiving and search. Hooks capture memory at session end and
after failures; `launchd/` jobs archive and back it up. 122 tests:

```bash
node --test scripts/memory-index.test.mjs scripts/dash-path-guard.test.mjs
```

Read the layer model and rules in `CLAUDE.md.example`.

## Credentials you must supply

Keyless MCP servers are registered automatically. These are skipped until you edit
`mcp-servers.json` and run `claude mcp add-json <name> '<json>' -s user`:

- `magic` (21st.dev): `API_KEY`
- `c4ai-sse` (Crawl4AI): `Authorization` header, plus a local Crawl4AI container on `:11235`
- `mobbin`, `greptile`: registered automatically; sign in on first use via `/mcp`

Memory backup (optional) needs `~/.claude/.env.memory-backup`; start from
`env.memory-backup.example`. It encrypts with `age` before upload and refuses to run unencrypted.

Always pass `-s user` to `claude mcp add`; without it a server is tied to the directory it was
added from.

## Review before trusting

- `settings.json` sets no `defaultMode`: permissions are Claude Code's defaults plus a deny list
  for `.env` files. Add your own `allow` rules.
- Hooks run local scripts from `~/.claude`. They are short; read them, as with any hook.
- `skillOverrides` turns off the C++ and Django skill packs. Flip them if you use those stacks.
- 29 plugins and 154 skills is a lot of always-loaded description text. Trim `plugins.txt` and
  `skills/` to what you use; `skills/context-budget` audits the cost.
- Four skills have no confirmed upstream license (`apple-design-hig`, `apple-design`,
  `agent-reach`, `humanizer`). See `SKILLS.md` before redistributing.

## Not included, on purpose

- Personal memory corpora, session history, logs, caches, and any credential.
- Runtime-generated skills (`learned`, `synced`).

## Licensing

Original files: MIT (`LICENSE`). Vendored third-party skills, agents, hooks and rules keep their
upstream MIT licenses; sources and licenses are listed in `THIRD_PARTY_LICENSES.md` and `NOTICE`.
