# Writing Memory From a Cloud Session

This project's memory lives **embedded in this repo**, at `.claude/memory/` — not the machine-local
default. That's exactly why a cloud session can see it: it's just files in the repo you cloned.

Reading it costs nothing extra — `.claude/memory/MEMORY.md` is already in your checkout. But
nothing writes to it automatically here the way it does on the owner's own machines (that relies on
a local hook this cloud sandbox doesn't have). If this session establishes a durable fact — a
decision, a trap that cost real time, a status nobody could re-derive from the code — write it
yourself before finishing, using the generator vendored into this repo:

1. **Write a NEW file** in `.claude/memory/`, named `<topic>-<YYYY-MM-DD>.md` (today's date).
   Never edit `.claude/memory/MEMORY.md` directly — it's generated, hand-edits are overwritten.
2. Frontmatter contract (the `name` field must equal the filename minus `.md`):

```yaml
---
name: <topic>-<YYYY-MM-DD>
description: >-
  The one fact you'd regret forgetting, as the hook, not a title. Max 240 chars.
metadata:
  type: project        # user | feedback | project | reference
  section: current      # must exist in this project's .claude/memory/sections.json, if one exists
  date: <YYYY-MM-DD>
  status: deployed       # deployed | pushed-not-merged | committed-not-pushed | uncommitted | plan-only
---
```

3. **Run the vendored generator** from the repo root: `node .claude/scripts/memory-index.mjs`.
   It rebuilds `.claude/memory/MEMORY.md` and validates the whole corpus. Fix whatever it reports.
4. **Commit both** the new fact file and the regenerated `MEMORY.md` in your normal commit for this
   work — this is a real part of the repo, not a side effect to leave out.

Only write one when something is genuinely durable — most tasks need none. If in doubt, skip it
rather than log that work merely *happened*.

**This is part of being done, not optional cleanup.** Before you report a task finished or open a
PR, explicitly ask yourself: did this establish a decision, a trap, or a status nothing else can
derive? If yes, the 4 steps above are not finished-work-plus-extra — they're part of the task
itself, same as running tests. No local hook will catch it for you here if you skip it.
