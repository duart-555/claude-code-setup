#!/usr/bin/env node
// Deterministic Layer-2 memory capture — three trigger points, one script.
//
// Why three triggers, not just SessionEnd: verified directly (not assumed)
// that SessionEnd only fires reliably on a clean `/exit` — not on Ctrl+C,
// a crash, a dropped connection, or a closed terminal. Relying on it alone
// means "incredibly reliable" was false advertising. So:
//
//   - SessionEnd   — the clean-exit case, full review of the transcript.
//   - PreCompact   — fires right before context gets summarized, which is
//                    exactly the moment the user's own worry ("after
//                    compact, info gets lost") would actually happen. This
//                    is the single highest-value trigger: cheap (only fires
//                    when a compaction is actually about to happen) and
//                    directly prevents the named failure mode.
//   - PostToolUse  — a throttled safety net (matcher: Write|Edit|MultiEdit).
//                    Bounds worst-case loss on a hard crash to one throttle
//                    window instead of "possibly the whole session." The
//                    throttle check itself is a cheap file-mtime read; the
//                    expensive model call only runs once the window has
//                    actually elapsed, so a normal session pays for this
//                    maybe 2-4 times, not once per edit.
//
// All three now also share a short cross-trigger debounce (see
// CROSS_TRIGGER_DEBOUNCE_MS below) on top of whichever window applies to the
// specific trigger — added after rapid, unrelated session churn on one machine
// made SessionEnd fire dozens of times an hour with nothing to write each time.
//
// Why Haiku via `claude -p`, not a separate API key: rides the existing
// Claude Code subscription (same mechanism claude-mem already uses,
// verified this session to carry no separate Anthropic billing) — $0
// extra, not a new paid account, nowhere near the $5/month ceiling.
//
// This writes nothing itself. It delegates the judgment call (durable fact
// or not) to a real model invocation that already has this machine's
// CLAUDE.md loaded, so it follows the same "record only what cannot be
// derived" contract a human-driven session follows — then regenerates and
// commits the index so a stale write never lingers.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultMemoryDir } from "../scripts/memory-index.mjs";

const THROTTLE_MS = 15 * 60 * 1000; // 15 minutes — bounds worst-case crash loss

// Measured on a-vps, 2026-10-08: an unrelated automated process restarted a
// fresh `claude` session roughly every 60-90s, continuously, for over an hour.
// Each clean exit fired SessionEnd, and SessionEnd had no throttle at all — every
// single one burned a real 40-120s Haiku call, all but the first finding nothing
// to write. ~60 wasted calls/hour on one project alone. SessionEnd and PreCompact
// still need to fire close to instantly for the case they actually exist for (a
// real exit, a real compaction), so this debounce is short — long enough to
// absorb rapid session churn from something else entirely, short enough that it
// never meaningfully raises the crash-loss risk those two triggers exist to bound.
const CROSS_TRIGGER_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes

// Every run writes one line here — trigger, project, outcome, duration. Before
// this, the only way to tell whether this hook was working at all was to notice
// a new fact file (or not) and guess why. Measured gap, not a hypothetical one:
// backup/autoarchive/recall-on-failure all had their own log; this hook had none.
const LOG_PATH = join(homedir(), ".claude", "logs", "memory-auto-capture.log");

function logRun(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // logging must never be the reason a capture run fails
  }
}

function resolveClaudeBin() {
  const candidates = [join(homedir(), ".local/bin/claude"), join(homedir(), ".bun/bin/claude")];
  for (const c of candidates) if (existsSync(c)) return c;
  return "claude"; // fall back to PATH resolution (works on the Mac today)
}

// Reuses the generator's own path resolution end to end — both its
// --git-common-dir + escaping logic (a hand-rolled version of this got the
// my-project case wrong, silently breaking the throttle on every write) AND
// its in-repo-memory auto-detection, so a project with `.claude/memory`
// committed in its own repo gets throttled against THAT path, not a stale
// machine-local one nobody is writing to anymore.
function throttleFile(cwd) {
  return join(defaultMemoryDir(cwd), ".last-capture");
}

function shouldSkip(cwd, windowMs) {
  const f = throttleFile(cwd);
  try {
    const last = Number(readFileSync(f, "utf8").trim());
    if (Date.now() - last < windowMs) return true;
  } catch {
    // no throttle file yet — don't skip
  }
  return false;
}

function markCaptured(cwd) {
  try {
    writeFileSync(throttleFile(cwd), String(Date.now()));
  } catch {
    // best-effort — a missing memory dir just means SessionEnd/PreCompact
    // will create it on their own pass
  }
}

const MAX_STDIN = 1024 * 1024;
let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (stdinData.length < MAX_STDIN) stdinData += chunk;
});
process.stdin.on("end", () => {
  main().catch((err) => {
    console.error("[memory-auto-capture] error:", err.message);
    process.exit(0); // never block the triggering hook on this script's own failure
  });
});

async function main() {
  const trigger = process.argv[2] || "session-end"; // session-end | pre-compact | post-tool-throttled

  let payload = {};
  try {
    payload = JSON.parse(stdinData || "{}");
  } catch {
    // malformed stdin — nothing to do
  }
  const cwd = payload.cwd || process.cwd();
  const transcriptPath = payload.transcript_path || "";

  // post-tool-throttled keeps its original 15-minute window (bounds crash loss).
  // session-end and pre-compact now get the short cross-trigger debounce — new,
  // since rapid session churn from something unrelated can hit either of them
  // just as easily as it hits post-tool-throttled.
  const windowMs = trigger === "post-tool-throttled" ? THROTTLE_MS : CROSS_TRIGGER_DEBOUNCE_MS;
  if (shouldSkip(cwd, windowMs)) {
    logRun({ trigger, cwd, outcome: "skipped-throttle", durationMs: 0 });
    process.exit(0);
  }
  markCaptured(cwd); // mark immediately, for every trigger, so a slow/failed run doesn't retrigger instantly

  const triggerContext = {
    "session-end": "A Claude Code session in this project just ended (clean exit).",
    "pre-compact": "This session's context is about to be compacted/summarized — this is the exact moment information not yet written down would be lost.",
    "post-tool-throttled": "Periodic safety-net checkpoint during a long-running session (fires at most every 15 minutes, only after real file edits) — bounds how much would be lost if this session crashed instead of exiting cleanly.",
  }[trigger];

  const prompt = `${triggerContext} Transcript: ${transcriptPath || "(not provided)"}

Your global CLAUDE.md (already loaded) specifies exactly what belongs in Layer-2 memory and what doesn't — follow that contract, don't improvise a different one.

1. If a transcript path was given, read it (on a checkpoint/safety-net pass, the END of the transcript — the most recent activity — matters most, you don't need to re-review everything already covered by prior passes). Decide: did this session establish, change, or invalidate a DURABLE fact — a decision and its reason, a trap that cost real time, or status nobody could re-derive from the code? Most passes produce none. If this one didn't, do nothing and say so in one line. Do not write a fact just to have written one.
2. If it did, write one new memory file per fact in this project's memory directory, following the frontmatter contract exactly (name == filename minus .md, description under the section's char limit, metadata.type/section/date/status). Prefer correcting an existing file over adding a near-duplicate — search first.
3. Then run \`node ~/.claude/scripts/memory-index.mjs\` from this directory and fix anything it reports.
4. Commit the memory directory if anything changed: \`git -C <memory dir> add -A -- . && git -C <memory dir> commit -m "<one line>" -- .\`.
   The trailing \`-- .\` is NOT optional: some projects now keep their memory folder INSIDE their own repo (for Cloud Code visibility) rather than in a separate one. In that case "add -A" with no pathspec would stage the entire outer repo, including whatever unrelated work-in-progress is sitting there uncommitted. "-A -- ." scopes to this directory in both setups — identical behavior when the memory folder is its own repo root, safely scoped when it is nested inside a larger one.
5. If the commit succeeded, also push, but only if this memory dir has its own \`origin\` remote (a dedicated memory-only repo — most projects now have one; a few legacy ones are still machine-local-only by design and have none): \`git -C <memory dir> remote get-url origin >/dev/null 2>&1 && git -C <memory dir> push || true\`. The \`|| true\` is required — no remote is a normal, silent no-op, not an error.

Be silent and fast when there's nothing to write — that's the common case, not a failure.`;

  const startedAt = Date.now();
  try {
    execFileSync(
      resolveClaudeBin(),
      ["-p", prompt, "--model", "haiku"],
      { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
    );
    logRun({ trigger, cwd, outcome: "ok", durationMs: Date.now() - startedAt });
  } catch (err) {
    console.error(`[memory-auto-capture:${trigger}] capture run failed:`, err.message);
    logRun({ trigger, cwd, outcome: "error", durationMs: Date.now() - startedAt, error: err.message });
  }
  process.exit(0);
}
