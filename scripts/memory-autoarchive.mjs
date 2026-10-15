#!/usr/bin/env node
/**
 * Automatic memory archiving — every project corpus, unattended.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MEMORY.md` is the only memory that loads automatically, and it has a hard
 * ceiling (200 lines OR 25 KB, whichever comes first). Past it the index stops
 * being read AND EVERY MEMORY BECOMES UNREACHABLE AT ONCE — including the ones
 * doing real work. That failure is not gradual and it is not loud.
 *
 * The SessionStart hook WARNS at 17 KB. A warning depends on somebody acting on
 * it: the project corpus reached 18.8 KB with that warning firing every session
 * for a week. This is the part that acts.
 *
 * WHAT IT WILL NOT DO — the safety properties matter more than the feature
 * -----------------------------------------------------------------------
 *  1. NEVER deletes. It `git mv`s into `archive/`, which the generator ignores
 *     for index purposes but `--search` still reaches. Nothing becomes
 *     unfindable; it only stops costing bytes that load every session.
 *  2. NEVER touches a memory recording LIVE STATE. `uncommitted`, `plan-only`,
 *     `committed-not-pushed`, `pushed-not-merged` are exactly the facts nobody
 *     can re-derive from git or the code — the whole reason this layer exists.
 *     Excluded whatever their age.
 *  3. NEVER touches `type: user` or `type: feedback`. Standing instructions about
 *     the owner and how to work do not go stale by ageing.
 *  4. NEVER touches anything younger than MIN_AGE_DAYS, so a corpus cannot eat
 *     the work of the week it is in.
 *  5. Runs at all only when a corpus is genuinely near the ceiling, and stops the
 *     moment it is under target. On a healthy corpus it is a no-op.
 *  6. Commits every move with a message naming what moved and why, so a single
 *     `git revert` in the memory repo undoes the whole run.
 *
 * Order within a corpus is oldest-first — the only ranking defensible without
 * reading the content. Reading the content is the job of `--audit` plus a human,
 * which this deliberately does not try to replace.
 *
 * Run:  node ~/.claude/scripts/memory-autoarchive.mjs [--dry-run] [--verbose]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const LOG = join(homedir(), ".claude", "logs", "memory-autoarchive.log");
/** Written by sync-claude-config.sh, one absolute project-root path per line —
 *  the only way this script learns about embedded (<project>/.claude/memory/)
 *  corpora, since those live at arbitrary paths with no shared parent to scan. */
const EMBEDDED_REGISTRY = join(homedir(), ".claude", "embedded-memory-projects.txt");

/** Act only above this, and stop once under TARGET. The generator's own warning
 *  fires at 17 KB; acting at 19 leaves a band where a human can still choose —
 *  automation should be the backstop, not the first mover. */
const ACT_ABOVE_KB = 19;
const TARGET_KB = 15;
/** Nothing from the current working period, whatever else is true of it. */
const MIN_AGE_DAYS = 30;

/** Statuses meaning "live state nobody can re-derive" — never archive. */
const LIVE_STATUS = new Set([
  "uncommitted",
  "plan-only",
  "committed-not-pushed",
  "pushed-not-merged",
]);
/** Types that are standing instructions rather than project history. */
const NEVER_TYPES = new Set(["user", "feedback"]);

/**
 * `pin: true` in a memory's metadata means "never auto-archive this", full stop.
 *
 * Oldest-first is the only ranking defensible without reading content, and it is
 * blunt: a standing reference that happens to be old (a project charter, a legal
 * position) ranks the same as a settled batch record. Rather than pretend the
 * heuristic is cleverer than it is, this gives a human a way to say so once and
 * have it stick. Anything pinned is skipped whatever its age or size.
 */
const isPinned = (src) => /^\s*pin:\s*true\s*$/m.test(src);

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const VERBOSE = args.has("--verbose");

const log = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    mkdirSync(join(homedir(), ".claude", "logs"), { recursive: true });
    appendFileSync(LOG, stamped + "\n");
  } catch {
    /* logging must never be the thing that fails a maintenance run */
  }
};

const field = (src, name) => (src.match(new RegExp(`^\\s*${name}:\\s*(\\S+)`, "m")) ?? [])[1] ?? null;

/**
 * The index cost of one memory: its description is what `MEMORY.md` prints, and
 * index bytes are the only bytes that load automatically. Approximated here
 * rather than taken from the generator, because the generator must run with a
 * PROJECT as cwd and this script deliberately never needs to resolve one.
 */
function indexCost(src, filename) {
  const desc = (src.match(/description:\s*([\s\S]*?)\n[a-z_]+:/) ?? [])[1] ?? "";
  return desc.replace(/\s+/g, " ").trim().length + filename.length + 8;
}

function corpora() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS)
    .map((p) => join(PROJECTS, p, "memory"))
    .filter((d) => existsSync(d) && existsSync(join(d, ".git")));
}

/** Embedded corpora have NO .git of their own (by design — see ensureGitRepo's
 *  gitlink-avoidance in memory-index.mjs) so they can't be found by the same
 *  filter as corpora(). Trust the registry instead of scanning for them. */
function embeddedCorpora() {
  if (!existsSync(EMBEDDED_REGISTRY)) return [];
  return readFileSync(EMBEDDED_REGISTRY, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((root) => join(root, ".claude", "memory"))
    .filter((d) => existsSync(d));
}

/** PROJECTS-prefixed dirs are the repo root themselves; embedded dirs are a
 *  subtree of someone else's project repo, so label by the project folder name. */
function corpusLabel(dir) {
  if (dir.startsWith(PROJECTS + "/")) return dir.replace(PROJECTS + "/", "").replace("/memory", "");
  return dir.replace(/\/\.claude\/memory$/, "").split("/").pop() + " (embedded)";
}

function auditCorpus(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const now = Date.now();
  const entries = files.map((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    const date = field(src, "date");
    const parsed = date ? Date.parse(date) : NaN;
    const ageDays = Number.isFinite(parsed)
      ? (now - parsed) / 86_400_000
      : (now - statSync(join(dir, f)).mtimeMs) / 86_400_000;
    return {
      file: f,
      cost: indexCost(src, f),
      ageDays,
      status: field(src, "status") ?? "none",
      type: field(src, "type") ?? "project",
      pinned: isPinned(src),
    };
  });
  const totalKb = entries.reduce((s, e) => s + e.cost, 0) / 1024;
  return { entries, totalKb };
}

const archivable = (e) =>
  !e.pinned && !NEVER_TYPES.has(e.type) && !LIVE_STATUS.has(e.status) && e.ageDays >= MIN_AGE_DAYS;

const git = (dir, argv) => execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8" }).trim();

let actedAnywhere = false;

for (const dir of [...corpora(), ...embeddedCorpora()]) {
  const { entries, totalKb } = auditCorpus(dir);
  const name = corpusLabel(dir);

  if (totalKb < ACT_ABOVE_KB) {
    if (VERBOSE) log(`OK    ${name} — ${totalKb.toFixed(1)} KB, under the ${ACT_ABOVE_KB} KB line`);
    continue;
  }

  const candidates = entries.filter(archivable).sort((a, b) => b.ageDays - a.ageDays);
  const moved = [];
  let running = totalKb;
  for (const c of candidates) {
    if (running <= TARGET_KB) break;
    moved.push(c);
    running -= c.cost / 1024;
  }

  if (moved.length === 0) {
    log(
      `WARN  ${name} — ${totalKb.toFixed(1)} KB and NOTHING is safely archivable ` +
        `(all recent, live-state, or standing instructions). Needs a human: ` +
        `node ~/.claude/scripts/memory-index.mjs --audit`
    );
    continue;
  }

  log(
    `ACT   ${name} — ${totalKb.toFixed(1)} KB → ~${running.toFixed(1)} KB, archiving ${moved.length}` +
      (DRY ? " (dry run, nothing moved)" : "")
  );
  for (const m of moved) log(`        ${m.file}  (${Math.round(m.ageDays)}d, ${m.status})`);
  if (DRY) continue;

  try {
    mkdirSync(join(dir, "archive"), { recursive: true });
    for (const m of moved) git(dir, ["mv", m.file, join("archive", m.file)]);
    // `-- .` not `-A`: an embedded corpus is a subtree of someone else's project
    // repo, and `-A` with no pathspec stages the ENTIRE outer repo from its root
    // — exactly the gitlink/sweep bug already documented in CLAUDE.md. `-- .`
    // scopes to this directory in both layouts: harmless where dir IS the repo
    // root, load-bearing where it's an embedded subtree.
    git(dir, ["add", "--", "."]);
    git(dir, [
      "commit",
      "-q",
      "-m",
      `memory: auto-archive ${moved.length} settled memories ` +
        `(index ${totalKb.toFixed(1)} KB -> ~${running.toFixed(1)} KB)\n\n` +
        `Archived, NOT deleted — --search still reaches every one of these.\n` +
        `Excluded by rule: live-state statuses, user/feedback types, anything under ${MIN_AGE_DAYS} days.\n\n` +
        moved.map((m) => `  ${m.file} (${Math.round(m.ageDays)}d, ${m.status})`).join("\n"),
    ]);
    actedAnywhere = true;
    log(`        committed in ${dir}`);
    log(`        MEMORY.md is now STALE here — it still lists the archived files.`);
    const generatorHint = dir.startsWith(PROJECTS + "/")
      ? "node ~/.claude/scripts/memory-index.mjs"
      : "node .claude/scripts/memory-index.mjs (from that project's root)";
    log(`        Regenerate from that project: ${generatorHint}`);
  } catch (error) {
    log(`ERROR ${name} — ${String(error).slice(0, 200)}`);
  }
}

if (!actedAnywhere && !DRY) log("done — no corpus needed action");
