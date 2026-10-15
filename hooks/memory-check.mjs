#!/usr/bin/env node
// SessionStart hook: surface memory problems that would otherwise be invisible.
//
// Why a check and not an auto-regenerate: a hook that writes and fails quietly is
// the exact failure this whole system exists to remove. This one writes NOTHING.
// It reports into the conversation, where it cannot fail silently — if it has
// something to say, you and the session both read it.
//
// SILENCE IS THE POINT. It prints only when something is actionable. Several
// SessionStart hooks already run here; one more that chatters every launch becomes
// wallpaper within a week and stops being read, which would make it worse than
// nothing. A healthy project produces no output at all.
//
// It deliberately does NOT report "these files predate the frontmatter contract" —
// the generator upgrades those by itself on the next run, so saying so every
// session would be noise about something already handled.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFacts,
  checkIntegrity,
  defaultMemoryDir,
  WARN_BYTES,
  FAIL_BYTES,
  WARN_LINES,
  FAIL_LINES,
  loadedIndexSize,
} from "../scripts/memory-index.mjs";

const MAX_NAMED = 5;
// Healthy is ~9 MB with 1,443 observations. 60 MB means the outbox is back.
const CLAUDE_MEM_DB_WARN_MB = 60;

// Index growth was the one failure this hook could not see, and it is the only one
// shaped like a CLIFF rather than a slope: past FAIL_BYTES the index stops being
// loaded and EVERY memory becomes unreachable at once, not gradually. The generator
// already guards it (settled decision 2 in MEMORY_SYSTEM_PLAN.md — "the failure it
// prevents is invisible, so this one has to be loud") but only when run by hand,
// which is precisely when nobody runs it.
//
// Headroom is reported in MEMORIES, not only in bytes. "3.6 KB left" is a number;
// "about 14 more memories" is a deadline, and a deadline is what gets someone to act
// while acting is still cheap — archiving is a two-minute job at 18 KB and an
// emergency at 22. The per-memory cost is measured from this corpus's own entry
// lines rather than a constant, because a project whose descriptions run long burns
// headroom faster and has earned the earlier warning.
// TWO dimensions, because Claude Code loads "the first 200 lines OR the first
// 25KB, whichever comes first". Guarding bytes alone missed a real case: many
// short entries reach the line limit while still well under the byte cap, and
// everything past line 200 stops loading with no warning at all.
// Report whichever is nearer its limit, so the advice names the real constraint.
function indexPressure(raw) {
  const { bytes, lines } = loadedIndexSize(raw);
  if (bytes <= WARN_BYTES && lines <= WARN_LINES) return null;

  const entries = raw.split("\n").filter((line) => line.startsWith("- ["));
  // +1 per entry for the newline it costs.
  const perEntry = entries.length
    ? entries.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0) / entries.length
    : 0;

  const byteRoom = FAIL_BYTES - bytes;
  const lineRoom = FAIL_LINES - lines;
  // Proportional, not absolute: 90 spare lines and 6 spare KB are not comparable.
  const linesBind = lineRoom / FAIL_LINES < byteRoom / FAIL_BYTES;
  const headroom = linesBind ? lineRoom : byteRoom;

  return {
    linesBind,
    lines,
    lineRoom: Math.abs(lineRoom),
    kilobytes: (bytes / 1024).toFixed(1),
    headroomKb: (Math.abs(byteRoom) / 1024).toFixed(1),
    over: headroom <= 0,
    // null when there are no entry lines to measure — better to say nothing about
    // slots than to invent a number from a divide-by-zero. One memory costs one
    // line, so under the line constraint the slot count IS the remaining lines.
    slots: linesBind
      ? Math.max(0, lineRoom)
      : perEntry > 0
        ? Math.max(0, Math.floor(byteRoom / perEntry))
        : null,
  };
}

function namesOf(files) {
  const shown = files.slice(0, MAX_NAMED).join(", ");
  return files.length > MAX_NAMED ? `${shown}, +${files.length - MAX_NAMED} more` : shown;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let cwd = process.cwd();
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const payload = JSON.parse(raw);
      if (payload && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
    }
  } catch {
    // A malformed payload is not worth a word to the user; fall back to cwd.
  }

  const dir = defaultMemoryDir(cwd);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

  const facts = readFacts(dir);
  if (facts.length === 0) return;

  const integrity = checkIntegrity(dir, facts);
  const today = new Date().toISOString().slice(0, 10);
  const stale = facts
    .filter((f) => f.meta.verify_by && /^\d{4}-\d{2}-\d{2}$/.test(f.meta.verify_by) && f.meta.verify_by < today)
    .map((f) => f.file);

  const problems = [];

  if (integrity.missingIndex) {
    const one = facts.length === 1;
    problems.push(
      `${facts.length} memor${one ? "y exists" : "ies exist"} here but there is no MEMORY.md — ` +
        `${one ? "it" : "none of them"} will ${one ? "never be" : "not be"} loaded. Run: node ~/.claude/scripts/memory-index.mjs`,
    );
  } else {
    if (integrity.orphans.length) {
      const count = integrity.orphans.length;
      problems.push(
        `${count} memor${count === 1 ? "y is" : "ies are"} not listed in MEMORY.md, so nothing can find ${count === 1 ? "it" : "them"} (${namesOf(integrity.orphans)}). Run the generator.`,
      );
    }
    if (integrity.broken.length) {
      problems.push(
        `MEMORY.md links ${integrity.broken.length} file(s) that no longer exist (${namesOf(integrity.broken)}).`,
      );
    }
  }

  if (stale.length) {
    const one = stale.length === 1;
    problems.push(
      `${stale.length} memor${one ? "y is" : "ies are"} past ${one ? "its" : "their"} verify-by date ` +
        `(${namesOf(stale)}) — re-check before relying on ${one ? "it" : "them"}.`,
    );
  }

  // Only meaningful against an index that exists. When it does not, the missing-index
  // problem above already says the far more urgent thing.
  const pressure = integrity.missingIndex || !integrity.raw ? null : indexPressure(integrity.raw);
  if (pressure) {
    const room =
      pressure.slots === null
        ? ""
        : ` — room for about ${pressure.slots} more memor${pressure.slots === 1 ? "y" : "ies"}`;
    // Name the dimension that is actually about to cut the index off. "17 KB of
    // 22" is useless advice when it is the line count that binds.
    const where = pressure.linesBind
      ? `MEMORY.md is ${pressure.lines} lines, ${pressure.lineRoom} ${pressure.over ? "OVER" : "from"} the ${FAIL_LINES}-line limit`
      : `MEMORY.md is ${pressure.kilobytes} KB, ${pressure.headroomKb} KB ${pressure.over ? "OVER" : "from"} the ${(FAIL_BYTES / 1024).toFixed(0)} KB limit`;
    problems.push(
      pressure.over
        ? `${where} — past this the index stops being loaded and every memory here becomes unreachable at once. ` +
            `Retire something now: node ~/.claude/scripts/memory-index.mjs --audit`
        : `${where}${room}. ` +
            `At the limit the index stops loading and every memory becomes unreachable at once. ` +
            `What to retire: node ~/.claude/scripts/memory-index.mjs --audit`,
    );
  }

  const bloat = claudeMemBloat();
  if (bloat) problems.push(bloat);

  if (problems.length === 0) return;

  console.log("Memory needs attention:");
  for (const problem of problems) console.log(`- ${problem}`);
}

/**
 * claude-mem is the automatic half of the memory system, and on 2026-08-04 its
 * database was 136 MB of which 127 MB was `sync_outbox` — operations queued for a
 * cloud-sync hub that was never configured, growing ~50,000 rows/day and drained
 * by nothing. Purged to 8.6 MB. It queues regardless of whether sync exists, so
 * it WILL regrow; this is what makes that visible before it is another 100 MB.
 *
 * Deliberately a stat() and not a SQL query: this runs at every session start, so
 * it must cost nothing and must not depend on sqlite3 being installed. File size
 * is the symptom anyway.
 */
function claudeMemBloat() {
  const db = join(homedir(), ".claude-mem", "claude-mem.db");
  try {
    if (!existsSync(db)) return null;
    const megabytes = statSync(db).size / (1024 * 1024);
    if (megabytes < CLAUDE_MEM_DB_WARN_MB) return null;
    return (
      `claude-mem.db is ${megabytes.toFixed(0)} MB. Its sync_outbox queues rows for a cloud hub ` +
      `that is not configured and never drains. Check and purge: ` +
      `sqlite3 ~/.claude-mem/claude-mem.db "select count(*) from sync_outbox;"`
    );
  } catch {
    return null;
  }
}

// Never let a hook break a session start. Anything unexpected exits quietly.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
