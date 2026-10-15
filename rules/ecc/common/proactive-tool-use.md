# Proactive Tool Use (Cloud Code Parity)

Use the best-fit agent/tool for the task without waiting to be asked. Available tools differ by
*session*, not just by machine: a local session may have the owner's full personal MCP stack; a
Cloud Code session only has whatever connectors are attached to that specific cloud environment.
Check what's actually available in THIS session. If the ideal tool isn't connected, fall back
(WebSearch/WebFetch, or just do the task directly) rather than blocking or asking the owner to go
connect something mid-task.

**Agents vendored into `.claude/agents/` — fire on the matching signal, no prompt needed:**

| Signal | Agent |
|---|---|
| Any `.tsx`/`.jsx` or React/Next.js component logic touched | `react-reviewer` |
| Any `.ts`/`.js` touched | `typescript-reviewer` |
| Any `.py` touched | `python-reviewer` |
| Code just written or modified (general) | `code-reviewer` |
| Auth, payments, user input, or other security-sensitive code | `security-reviewer` |
| SQL, migrations, schema, or query changes | `database-reviewer` |
| New feature or bug fix | `tdd-guide` |
| Architectural decision (new subsystem, cross-cutting change) | `architect` |
| Complex/ambiguous feature request needing a plan first | `planner` |
| Build/runtime feels slow, bundle size, render perf | `performance-optimizer` |
| Error handling looks off, silently-caught exceptions | `silent-failure-hunter` |

These are triggers, not a quota — a one-line edit doesn't need a reviewer, but don't skip the
matching one when the signal is real.

**MCP tools, when connected in this session**: `context7` for library/framework/API behavior and
version-specific docs — skip for trivial/stdlib questions; `playwright` to verify a page actually
renders/behaves as claimed before calling UI work done. Default to WebSearch/WebFetch for
anything else, and don't stall the task waiting on a tool that isn't connected here.
