#!/usr/bin/env node
/**
 * Speak the corpus when something breaks.
 *
 * WHY
 * ---
 * `MEMORY.md` works because it loads by itself. The memory FILES do not work,
 * because they must be asked for — and the asking is the part that gets
 * forgotten. Measured: a scroll-handling bug cost a long
 * debugging detour, a wrong diagnosis reported to the user, and a purpose-built
 * browser probe across four profiles. The corpus already held the answer —
 * *"the scroll library reverts window.scrollTo"* — written weeks earlier. Nobody asked.
 *
 * A rule saying "search more" is the same shape this setup has already measured
 * into irrelevance (1 graph call in 44,897). So this takes the mechanism that
 * DOES work — automatic injection — and fires it at the one moment that is
 * mechanically detectable rather than a judgement call: a command just failed.
 *
 * DESIGN RULES, in the order that decides whether it survives a month
 * ------------------------------------------------------------------
 *  1. SILENT unless there is a real match. Most failures match nothing, and that
 *     is the point: a hook that speaks on every failure is wallpaper within a
 *     week, and then the one time it matters it is already being skipped.
 *  2. Rank by RARITY. A token in 2 memories is a signal; one in 40 ("error",
 *     "test", "failed") is noise. Document-frequency filtering does this with no
 *     model call and no configuration.
 *  3. HARD CAP of 2 memories, description lines only. It can never flood context.
 *  4. DEBOUNCE per memory — the same file cannot surface twice in an hour, or a
 *     failing test loop would repeat itself into being ignored.
 *  5. It cannot break anything: it runs after a command has ALREADY failed, only
 *     appends text, and swallows every internal error.
 *  6. EVERY FIRE IS LOGGED, so "did this help?" is answerable in a month with a
 *     number instead of an impression — the discipline that proved the graph
 *     rule dead and the Context7 rule alive.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Reuse the generator's own corpus resolution. It keys on the GIT COMMON DIR, so
// a worktree resolves to its parent's corpus — the exact trap `--show-toplevel`
// walks into. Re-deriving it here would be a second copy of a rule that has
// already been got wrong once.
import { defaultMemoryDir } from "../scripts/memory-index.mjs";

const LOG_DIR = join(homedir(), ".claude", "logs");
const LOG = join(LOG_DIR, "memory-recall.log");
const STATE = join(LOG_DIR, ".memory-recall-state.json");

const DEBOUNCE_MS = 60 * 60 * 1000;
/** A token in more than this many memories is a common word, not a lead. */
const MAX_DOC_FREQUENCY = 4;
const MAX_HITS = 2;

/** Words that look distinctive but are ambient in any failing build. Without
 *  this the hook cheerfully matches "error" against half the corpus. */
const AMBIENT = new Set(
  ("error errors failed failure fail test tests testing expected received assert assertion " +
    "cannot could unable module file files line lines code exit status command run running " +
    "node npm npx yarn pnpm build builds warn warning info debug true false null undefined " +
    "string number object array function const return import export default async await " +
    "http https www com org net localhost port timeout time timed with from this that " +
    "have has been was were will would should there their they them then than about " +
    "please check checking found using used use the and for not but all any set get new " +
    // Added after the first live test surfaced an irrelevant memory on "position".
    // These are English filler that survives the length filter and is common in
    // BOTH stack traces and prose, so it matches almost anything.
    "position value values result results page pages data state first second third " +
    "before after still only into more most when where which while what some each " +
    "both other same next last also very just even much many make made does done " +
    "here over under between during without within across every none such own")
    .split(/\s+/)
);

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }

  const r = payload?.tool_response;
  const text = [
    r?.stderr,
    r?.stdout,
    r?.error,
    typeof r === "string" ? r : "",
    payload?.tool_input?.command,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000); // a huge log is no more informative than its first lines
  if (!text.trim()) return;

  let dir;
  try {
    dir = defaultMemoryDir(process.cwd());
  } catch {
    return;
  }
  if (!dir || !existsSync(dir)) return;

  // The archive is searched too — that is what makes archiving safe rather than
  // a slow way of forgetting, and the answer is in the archive today.
  const files = [];
  for (const [prefix, base] of [
    ["", dir],
    ["archive/", join(dir, "archive")],
  ]) {
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      try {
        files.push({ name: prefix + f, src: readFileSync(join(base, f), "utf8") });
      } catch {
        /* unreadable file is not a reason to fail */
      }
    }
  }
  if (files.length === 0) return;

  const tokenize = (s) =>
    new Set(
      (s.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []).filter((w) => !AMBIENT.has(w))
    );

  const descriptionOf = (src) =>
    ((src.match(/description:\s*([\s\S]*?)\n[a-z_]+:/) ?? [])[1] ?? "") +
    " " +
    ((src.match(/^\s*(?:title|name):\s*(.*)$/m) ?? [])[1] ?? "");

  const df = new Map();
  /** Tokens in a memory's DESCRIPTION — the curated one-line distillation. */
  const descTokens = new Map();
  for (const f of files) {
    for (const t of tokenize(f.src)) {
      if (!df.has(t)) df.set(t, new Set());
      df.get(t).add(f.name);
    }
    descTokens.set(f.name, tokenize(descriptionOf(f.src)));
  }

  const candidates = [...tokenize(text)]
    .filter((t) => df.has(t) && df.get(t).size <= MAX_DOC_FREQUENCY)
    .sort((a, b) => df.get(a).size - df.get(b).size);
  if (candidates.length === 0) return;

  const score = new Map();
  const why = new Map();
  for (const t of candidates.slice(0, 25)) {
    for (const f of df.get(t)) {
      score.set(f, (score.get(f) ?? 0) + 1);
      if (!why.has(f)) why.set(f, []);
      why.get(f).push(t);
    }
  }

  // Two independent tokens, or one RARE one (in at most 2 of the whole corpus).
  //
  // This threshold was wrong on the first try and the test caught it: `timeout`
  // lives in exactly 2 memories, so requiring a token UNIQUE to one file made the
  // hook silent on the very failure it was written for. Rare, not unique, is the
  // right bar — a term appearing in 2 of 60 memories is already a strong signal,
  // while a single common-ish match is the false-positive shape that would turn
  // this into noise.
  // THE DESCRIPTION IS THE SIGNAL. Rarity alone is not relevance: the second
  // live test surfaced two memories matched on `timeouterror` and `waiting` —
  // both genuinely rare (df 1), both incidental words buried in a body, and both
  // useless — while pushing out the one memory that actually explained the
  // failure. A term appearing in the curated one-line description is a claim
  // about what the memory is FOR; the same term deep in a body is a coincidence.
  //
  // So: a description match qualifies on its own. A body-only match has to bring
  // two independent rare tokens before it is worth anyone's attention.
  const RARE = 2;
  const inDescription = (f) => why.get(f).filter((t) => descTokens.get(f)?.has(t)).length;
  const ranked = [...score.entries()]
    .filter(([f, n]) => inDescription(f) > 0 || n >= 2)
    .sort(
      (a, b) =>
        inDescription(b[0]) - inDescription(a[0]) ||
        Math.min(...why.get(a[0]).map((t) => df.get(t).size)) -
          Math.min(...why.get(b[0]).map((t) => df.get(t).size)) ||
        b[1] - a[1]
    )
    .filter(([f]) => inDescription(f) > 0 || why.get(f).some((t) => df.get(t).size <= RARE));
  if (ranked.length === 0) return;

  let state = {};
  try {
    state = JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    /* first run */
  }
  const now = Date.now();
  const fresh = ranked.filter(([f]) => now - (state[f] ?? 0) > DEBOUNCE_MS).slice(0, MAX_HITS);
  if (fresh.length === 0) return;

  const describe = (name) => {
    const src = files.find((f) => f.name === name)?.src ?? "";
    const d = (src.match(/description:\s*([\s\S]*?)\n[a-z_]+:/) ?? [])[1] ?? "";
    return d.replace(/^["'>|\s-]+/, "").replace(/["\s]+$/, "").replace(/\s+/g, " ").slice(0, 320);
  };

  const body = fresh
    .map(
      ([f]) =>
        `• ${f} — matched on: ${[...new Set(why.get(f))].slice(0, 4).join(", ")}\n  ${describe(f)}`
    )
    .join("\n\n");

  process.stdout.write(
    "That failed, and this project's memory may already know why. Read these " +
      "BEFORE running another experiment — a wrong diagnosis has been reached " +
      "this way before:\n\n" +
      body +
      "\n\nFull text: node ~/.claude/scripts/memory-index.mjs --search <term>\n" +
      "(Keyword match, not a judgement — ignore it if it is irrelevant.)\n"
  );

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    for (const [f] of fresh) state[f] = now;
    writeFileSync(STATE, JSON.stringify(state));
    appendFileSync(
      LOG,
      `${new Date().toISOString()} fired=${fresh.length} files=${fresh
        .map(([f]) => f)
        .join(",")} tokens=${candidates.slice(0, 6).join(",")}\n`
    );
  } catch {
    /* logging must never be why a hook fails */
  }
}

try {
  main();
} catch {
  // A recall hook must never be the reason a session gets worse after a failure.
}
process.exit(0);
