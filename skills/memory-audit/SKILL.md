---
name: memory-audit
description: Reviews a project's memory corpus for contradictions, superseded facts, duplication, and things that were never worth recording. Use quarterly, when memories start disagreeing, or when the index is close to its size limit.
---

# Memory Audit

The generator (`~/.claude/scripts/memory-index.mjs`) enforces everything mechanical: structure,
size, staleness by date. It cannot enforce the thing that actually rots a memory system — that
two memories can flatly contradict each other, and nothing about their shape reveals it.

That is what this skill is for. It is judgement work, so it needs a session, not a script.

## When to run

- Quarterly. Pair it with the backup restore drill so both live on one schedule.
- When the generator warns the index is approaching its size limit.
- When you notice two memories disagreeing — audit the whole corpus, not just that pair.
- Before a long gap in a project, so the next person meets a clean corpus.

## How to run

```
node ~/.claude/scripts/memory-index.mjs --audit
```

Run it from the project directory. It writes nothing. It prints every memory's index line
grouped by section, plus the mechanical findings already computed — do not spend effort
re-deriving those.

## What to look for

The packet ends with four questions, ordered by how much damage each does:

1. **Contradictions.** Two memories asserting incompatible things. This is the worst failure,
   because both look authoritative and nothing flags either. A real example from this machine:
   one memory said the database had no automatic backups; another said backups ran nightly and
   were healthy. Both were true when written, months apart. Name the pair, say which one
   today's evidence supports, and propose the correction.

2. **Superseded.** A memory quietly overtaken by a later one — not contradicted, just no longer
   the current state. These accumulate silently and inflate the index.

3. **Duplication.** Two memories covering substantially the same ground. Propose a merge, and
   say which file should survive.

   **Read both files in full before proposing this.** The first real audit of this system got
   duplication wrong: eight memories all opened "2026-07-2X batch executed, N commits, live" and
   looked identical from the index, while their bodies held roughly 24 distinct rules between
   them. Merging would have destroyed those to recover 1.4 KB. Index lines that *read* alike are
   usually a description-quality problem — rewrite each to lead with the one thing only that
   file knows, which costs the same bytes and loses nothing.

4. **Derivable.** Anything `git log`, the database, or the code could answer on demand. This
   should never have been memory. It is the most common form of over-recording, and an
   over-full index is not richer memory — past its size limit the index stops loading and
   *every* memory becomes unreachable at once.

Also act on what the packet lists mechanically:

- **Past `verify_by`** — re-check the fact, then either move the date forward or correct it.
- **Perishable with no `verify_by`** — prices, tariffs, free-tier limits, third-party API
  behaviour. Propose a date. Do not set one you do not believe; a date invented to satisfy a
  validator is worse than none.
- **Archival candidates** — settled work, six months old, outside the primary section. Moving a
  file into `archive/` frees index bytes without losing anything: the generator ignores that
  directory, but `--search` still reaches it.

## Rules

- **Report first. Change nothing without the owner agreeing.** Deleting a memory is
  irreversible in effect even when git can recover the bytes, because nobody goes looking for
  what they no longer remember having.
- **Never hand-edit `MEMORY.md`.** It is generated. Fix the underlying file and re-run.
- To retire a memory: `git mv <file> archive/`, then re-run the generator.
- To merge two: fold the content into the survivor, archive the other, re-run.
- After any change, run `node ~/.claude/scripts/memory-index.mjs` and commit the memory
  directory.

## Output

A short report, grouped by the four categories above. For each finding give the files, what is
wrong, and the specific fix. If the corpus is clean, say so plainly and stop — an audit that
manufactures findings to look useful is worse than one that finds nothing.
