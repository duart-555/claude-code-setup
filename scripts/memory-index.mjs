#!/usr/bin/env node
// memory-index.mjs — generate MEMORY.md from the fact-files beside it.
//
// The problem this solves: MEMORY.md used to be hand-edited. Two Claude Code
// sessions running at once would each read it, each append their own line, and
// each write the whole file back — so the slower writer silently erased the
// faster one's entry. No error, no conflict marker. The fact-file survived on
// disk but became unreachable from the index, which is the only map anything
// has. Memory you still own but can never find again.
//
// The fix is not more care. It is to stop sharing a mutable file. Each session
// writes its OWN new fact-file; this script derives the index from all of them.
// Two sessions writing different files never touch the same bytes, so there is
// no lost update, because there is no shared write. Whoever runs this last
// produces an index containing everybody's work.
//
//   node ~/.claude/scripts/memory-index.mjs              regenerate for the current project
//   node ~/.claude/scripts/memory-index.mjs --check      validate only, write nothing
//   node ~/.claude/scripts/memory-index.mjs --dir <path> operate on an explicit memory directory
//
// Exits non-zero on any validation failure, and on an index large enough to be
// at risk of silently not loading. See ~/.claude/MEMORY_SYSTEM_PLAN.md.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// --- constants ---------------------------------------------------------------

// Index bytes are the ONLY memory bytes that load automatically — the fact-files
// are read only when something goes looking for them. So an index line is not a
// pointer to a memory, it largely IS the memory, and a flat per-line cap spends
// the same allowance on a live deployment note as on a UI gotcha from months ago.
// Sections therefore carry their own limit: `current` can run long, the rest stay
// short, and the total is bounded separately by the size guard below. Set
// `maxChars` per section (or `defaultMaxChars` for all) in sections.json.
const DEFAULT_MAX_DESCRIPTION_CHARS = 240;
const MAX_ALLOWED_DESCRIPTION_CHARS = 2000;

// The real limits, from Claude Code's own docs: "The first 200 lines of MEMORY.md,
// or the first 25KB, whichever comes first, are loaded at the start of every
// conversation. Content beyond that threshold is not loaded at session start."
// It is a CLIFF, not a slope, and nothing warns in-session — so hard-fail with
// headroom rather than at the edge, and warn while there is still room to act.
//
// TWO dimensions, and the earlier version of this file guarded only bytes. A
// corpus of many short entries reaches 200 lines while still well under 25 KB,
// and everything past line 200 would silently stop loading.
const NATIVE_MAX_BYTES = 25 * 1024;
const NATIVE_MAX_LINES = 200;
const FAIL_BYTES = Math.floor(NATIVE_MAX_BYTES * 0.88); // 22 KB
const FAIL_LINES = Math.floor(NATIVE_MAX_LINES * 0.88); // 176
const WARN_BYTES = Math.floor(NATIVE_MAX_BYTES * 0.68); // 17 KB
const WARN_LINES = Math.floor(NATIVE_MAX_LINES * 0.68); // 136

// Claude Code strips YAML frontmatter and block-level HTML comments before
// applying the limits, so the generated banner comment at the top of MEMORY.md
// costs nothing. Measure exactly what loads, or we would refuse to write files
// that are actually fine.
export function loadedIndexSize(raw) {
  const stripped = String(raw)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return {
    bytes: Buffer.byteLength(stripped, "utf8"),
    lines: stripped.split(/\r?\n/).length,
  };
}

const INDEX_FILE = "MEMORY.md";
const SECTIONS_FILE = "sections.json";
// Retired memories live here. The generator ignores it entirely, so archiving
// costs no index bytes — but --search still reaches it, which is the only reason
// archiving is safe rather than a slow way of losing things.
const ARCHIVE_DIR = "archive";

const VALID_TYPES = ["user", "feedback", "project", "reference"];
// "uncommitted" and "pushed-not-merged" were added after a real audit found three
// memories whose true state no existing value could express, so each carried a
// label that was simply wrong. A vocabulary that cannot say the truth guarantees
// false labels.
const VALID_STATUSES = [
  "deployed",
  "pushed-not-merged",
  "committed-not-pushed",
  "uncommitted",
  "plan-only",
  "superseded",
];

// Used only when a project has no sections.json of its own. Deliberately
// generic: "coverage" and "seo" mean nothing outside the project that coined
// them, and an index exists to be scanned, so its headings have to be the
// project's own vocabulary.
const FALLBACK_SECTIONS = [
  { id: "current", title: "Current state (read these first)" },
  { id: "decisions", title: "Decisions" },
  { id: "traps", title: "Traps and gotchas" },
  { id: "owner-actions", title: "Owner actions outstanding" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- tiny YAML-subset frontmatter parser -------------------------------------
// Deliberately not a YAML library: no dependencies, and the contract is a fixed
// shape (scalars, one folded block scalar, one nested map one level deep).

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// YAML ends a scalar at an unquoted `#` that starts the value or follows
// whitespace. Without this, a file written from the commented template in
// ~/.claude/CLAUDE.md stores "current    # must exist in sections.json" as its
// section and fails validation for a reason nobody would guess from the message.
function stripComment(value) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i++) {
    const character = value[i];

    if (inDouble && character === "\\") {
      i++;
      continue;
    }
    if (character === "'" && !inDouble) inSingle = !inSingle;
    else if (character === '"' && !inSingle) inDouble = !inDouble;
    else if (character === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim();
    }
  }
  return value;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { error: "no frontmatter block" };
  const lines = raw.split(/\r?\n/);

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { error: "frontmatter block is never closed" };

  const body = lines.slice(1, end);
  const data = {};
  let i = 0;

  while (i < body.length) {
    const line = body[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }

    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const value = stripComment(match[2].trim());

    // Block scalar: >- , > , | , |-
    if (/^[>|][-+]?$/.test(value)) {
      const folded = value.startsWith(">");
      const collected = [];
      i++;
      while (i < body.length && (!body[i].trim() || /^\s/.test(body[i]))) {
        collected.push(body[i].trim());
        i++;
      }
      data[key] = folded
        ? collected.filter(Boolean).join(" ")
        : collected.join("\n").trim();
      continue;
    }

    // Nested map: a bare key, then indented key/value lines.
    if (value === "") {
      const nested = {};
      i++;
      while (i < body.length && /^\s+\S/.test(body[i])) {
        const inner = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(body[i]);
        if (inner) nested[inner[1]] = unquote(stripComment(inner[2].trim()));
        i++;
      }
      data[key] = nested;
      continue;
    }

    data[key] = unquote(value);
    i++;
  }

  return { data };
}

// --- locating the memory directory -------------------------------------------

// Mirrors how Claude Code names project directories: every character that is
// not alphanumeric becomes a hyphen, so /Users/x/.claude/jobs becomes
// -Users-x--claude-jobs (the dot AND the slash each produce one hyphen).
function slugForPath(absolutePath) {
  return absolutePath.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The project a corpus belongs to, resolved the way Claude Code resolves it:
 * "The <project> path is derived from the git repository, so all worktrees and
 * subdirectories within the same repo share one auto memory directory."
 *
 * NOT `--show-toplevel`. In a linked worktree that returns the WORKTREE root, so
 * a session in one would build a second corpus while Claude Code kept using the
 * first — the corpus splits in two and nothing says so. `--git-common-dir` is
 * shared by every worktree of a repo, and its parent is the main worktree root:
 *
 *   main   /Users/x/project        → /Users/x/project/.git        → /Users/x/project
 *   linked /Users/x/project-seo-wt → /Users/x/project/.git        → /Users/x/project
 *
 * Outside a repo the project root is the cwd, which is also the fallback when
 * git is missing or the command is unsupported.
 */
export function projectRootFor(cwd) {
  for (const args of [
    ["rev-parse", "--path-format=absolute", "--git-common-dir"], // git >= 2.31
    ["rev-parse", "--git-common-dir"], // older git: may return a relative path
  ]) {
    try {
      const out = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!out) continue;
      const gitDir = isAbsolute(out) ? out : resolve(cwd, out);
      // `<root>/.git` → `<root>`. A bare repo has no working tree to speak of,
      // so fall back rather than inventing one.
      if (basename(gitDir) !== ".git") continue;
      return dirname(gitDir);
    } catch {
      // try the next form
    }
  }
  return cwd;
}

// A project's memory may live inside its own repo (`<root>/.claude/memory`)
// instead of the default machine-local path, when cross-environment
// visibility (Cloud Code, a different machine) matters more than the
// default's isolation — see "In-repo memory" in CLAUDE.md. Auto-detected by
// presence, not configured: a project opts in just by that directory
// existing, so there is still no per-project setup step anywhere else.
// Exported so every caller (the hook's throttle path included) resolves the
// same way instead of reimplementing this — reimplementing it is exactly how
// the a-vps throttle bug happened (see project-path-slug-must-reuse-generator).
function defaultMemoryDir(cwd) {
  const root = projectRootFor(cwd);
  const inRepo = join(root, ".claude", "memory");
  if (existsSync(inRepo)) return inRepo;
  return join(homedir(), ".claude", "projects", slugForPath(root), "memory");
}

// --- section configuration ----------------------------------------------------

function readCharLimit(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 40 || limit > MAX_ALLOWED_DESCRIPTION_CHARS) {
    throw new Error(
      `${SECTIONS_FILE}: ${label} must be a whole number between 40 and ${MAX_ALLOWED_DESCRIPTION_CHARS}, got ${JSON.stringify(value)}`,
    );
  }
  return limit;
}

function loadSections(dir) {
  const path = join(dir, SECTIONS_FILE);
  if (!existsSync(path)) {
    return {
      sections: FALLBACK_SECTIONS.map((s) => ({ ...s, maxChars: DEFAULT_MAX_DESCRIPTION_CHARS })),
      source: "fallback",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${SECTIONS_FILE} is not valid JSON: ${error.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed.sections;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${SECTIONS_FILE} must hold a non-empty "sections" array`);
  }

  const defaultMax = Array.isArray(parsed)
    ? DEFAULT_MAX_DESCRIPTION_CHARS
    : readCharLimit(parsed.defaultMaxChars, "defaultMaxChars", DEFAULT_MAX_DESCRIPTION_CHARS);

  const sections = list.map((entry) =>
    typeof entry === "string"
      ? { id: entry, title: entry, maxChars: defaultMax }
      : {
          id: entry.id,
          title: entry.title || entry.id,
          maxChars: readCharLimit(entry.maxChars, `maxChars for "${entry.id}"`, defaultMax),
        },
  );

  for (const section of sections) {
    if (!section.id) throw new Error(`${SECTIONS_FILE} has a section with no id`);
  }
  return { sections, source: SECTIONS_FILE };
}

// --- reading the corpus -------------------------------------------------------

function readFacts(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const facts = [];

  for (const entry of entries) {
    // Subdirectories are skipped wholesale, which is what retires a memory:
    // move it into archive/ and it keeps existing without spending index bytes.
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === INDEX_FILE) continue;

    const path = join(dir, entry.name);
    const raw = readFileSync(path, "utf8");
    const { data, error } = parseFrontmatter(raw);

    facts.push({
      file: entry.name,
      expectedName: entry.name.replace(/\.md$/, ""),
      path,
      raw,
      parseError: error || null,
      data: data || {},
      meta: (data && data.metadata) || {},
    });
  }

  return facts.sort((a, b) => a.file.localeCompare(b.file));
}

// --- atomic write --------------------------------------------------------------

// writeFileSync is not atomic: a reader (or a second generator) can observe a
// half-written file. Write beside the target, then rename — rename IS atomic
// within a filesystem, so the file is either the old one or the new one, never
// a torn mixture.
function writeAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

// --- migration ------------------------------------------------------------------
// Any project that predates this contract has fact-files with no section and no
// date, so validation would reject the whole corpus — which would mean a session
// writes a memory, the generator refuses, and the memory never reaches the index.
// That is the exact bug this tool exists to prevent, so migration is automatic
// rather than a step somebody has to remember in each old project.
//
// It only ever ADDS missing fields, by splicing lines into the existing
// frontmatter. Nothing already written is re-serialised, so provenance
// (originSessionId), unknown keys and the body survive byte for byte.

// The old hand-written index is the best evidence of where a memory belongs and
// what it was called, so read it before it gets overwritten.
function readIndexEntries(dir) {
  const path = join(dir, INDEX_FILE);
  const entries = new Map();
  if (!existsSync(path)) return entries;

  let heading = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const isHeading = /^##\s+(.*?)\s*$/.exec(line);
    if (isHeading) {
      heading = isHeading[1];
      continue;
    }
    const item = /^\s*-\s*\[(.+?)\]\(([^)]+\.md)\)\s*(?:—|-)?\s*(.*)$/.exec(line);
    if (!item) continue;
    entries.set(item[2], {
      title: item[1].replace(/^\*\*|\*\*$/g, "").trim(),
      heading,
      text: item[3] || "",
    });
  }
  return entries;
}

function normaliseHeading(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchSection(heading, sections) {
  if (!heading) return sections[0].id;
  const target = normaliseHeading(heading);

  for (const section of sections) {
    if (normaliseHeading(section.title) === target) return section.id;
  }
  // "SEO / GEO / AEO" -> tokens [seo, geo, aeo], which contains the id "seo".
  // Token equality, not substring: "ui" must not match inside "build".
  const tokens = target.split(" ");
  for (const section of sections) {
    if (tokens.includes(normaliseHeading(section.id))) return section.id;
  }
  return sections[0].id;
}

function inferDate(fact) {
  const fromFilename = /(\d{4}-\d{2}-\d{2})$/.exec(fact.expectedName);
  if (fromFilename) return fromFilename[1];

  const modified = fact.meta.modified;
  if (modified && /^\d{4}-\d{2}-\d{2}/.test(modified)) return modified.slice(0, 10);

  return new Date(statSync(fact.path).mtime).toISOString().slice(0, 10);
}

// Read off the old index line's own words. Checked most-specific first: a line
// saying "pushed to GitHub, NOT merged to main" is unmerged work, not deployed.
//
// "NOT COMMITTED" and "UNCOMMITTED" used to sit in the committed-not-pushed
// branch, which is backwards — work that was never committed is the opposite of
// work that was committed but not pushed. A real audit caught it mislabelling
// three memories, so uncommitted is now checked FIRST and has its own value.
function inferStatus(text) {
  if (!text) return null;
  if (/\bNOT COMMITTED\b|\bUNCOMMITTED\b/i.test(text)) return "uncommitted";
  if (/\bNOT MERGED\b/i.test(text) && /\bPUSHED\b/i.test(text)) return "pushed-not-merged";
  if (/\bNOT PUSHED\b|\bNOT MERGED\b/i.test(text)) return "committed-not-pushed";
  if (/\bDEPLOYED\b/i.test(text)) return "deployed";
  if (/\bPLAN ONLY\b|\bnothing built\b|\bplan only\b/i.test(text)) return "plan-only";
  return null;
}

function formatScalar(value) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/[:#"'\n]|^[>|@`&*!%[\]{}-]/.test(text)) {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return text;
}

function applyFrontmatterAdditions(raw, topAdditions, metaAdditions) {
  const lines = raw.split(/\r?\n/);

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const inserts = [];

  if (Object.keys(metaAdditions).length) {
    let metaStart = -1;
    for (let i = 1; i < end; i++) {
      if (/^metadata:\s*$/.test(lines[i])) {
        metaStart = i;
        break;
      }
    }

    if (metaStart === -1) {
      inserts.push({
        at: end,
        lines: ["metadata:", ...Object.entries(metaAdditions).map(([k, v]) => `  ${k}: ${formatScalar(v)}`)],
      });
    } else {
      const firstIndent = /^(\s+)\S/.exec(lines[metaStart + 1] || "");
      const indent = firstIndent ? firstIndent[1] : "  ";
      let metaEnd = metaStart + 1;
      while (metaEnd < end && /^\s+\S/.test(lines[metaEnd])) metaEnd++;
      inserts.push({
        at: metaEnd,
        lines: Object.entries(metaAdditions).map(([k, v]) => `${indent}${k}: ${formatScalar(v)}`),
      });
    }
  }

  if (Object.keys(topAdditions).length) {
    let nameIndex = -1;
    for (let i = 1; i < end; i++) {
      if (/^name:\s/.test(lines[i])) {
        nameIndex = i;
        break;
      }
    }
    inserts.push({
      at: nameIndex === -1 ? 1 : nameIndex + 1,
      lines: Object.entries(topAdditions).map(([k, v]) => `${k}: ${formatScalar(v)}`),
    });
  }

  // Splice from the bottom up so earlier insertion points keep their indices.
  inserts.sort((a, b) => b.at - a.at);
  for (const insert of inserts) lines.splice(insert.at, 0, ...insert.lines);
  return lines.join("\n");
}

// Replace an existing top-level scalar in place, leaving every other byte alone.
function rewriteTopScalar(raw, key, value) {
  const pattern = new RegExp(`^${key}:[^\\n]*$`, "m");
  if (!pattern.test(raw)) return raw;
  return raw.replace(pattern, `${key}: ${formatScalar(value)}`);
}

function migrate(dir, facts, sections) {
  const indexEntries = readIndexEntries(dir);
  const changes = [];

  for (const fact of facts) {
    if (fact.parseError) continue;

    const entry = indexEntries.get(fact.file);
    const topAdditions = {};
    const metaAdditions = {};

    // Older memories used `name` as a human title ("Example bot project overview")
    // rather than the filename slug. The contract requires name == filename, so
    // the filename wins — but a title is worth keeping, and that is what `title`
    // is for. A name with no whitespace was a competing slug, not a title, so it
    // is dropped rather than displayed.
    const nameIsWrong = typeof fact.data.name === "string" && fact.data.name !== fact.expectedName;
    const oldNameReadsAsTitle = nameIsWrong && /\s/.test(fact.data.name.trim());
    if (nameIsWrong && oldNameReadsAsTitle && !fact.data.title && !(entry && entry.title)) {
      topAdditions.title = fact.data.name.trim();
    }

    if (!fact.data.title && !topAdditions.title && entry && entry.title) topAdditions.title = entry.title;
    if (!fact.meta.section) metaAdditions.section = matchSection(entry && entry.heading, sections);
    if (!fact.meta.date) metaAdditions.date = inferDate(fact);
    if (!fact.meta.status) {
      const status = inferStatus(entry && entry.text);
      if (status) metaAdditions.status = status;
    }

    if (!nameIsWrong && !Object.keys(topAdditions).length && !Object.keys(metaAdditions).length) continue;

    const raw = readFileSync(fact.path, "utf8");
    const withName = nameIsWrong ? rewriteTopScalar(raw, "name", fact.expectedName) : raw;
    const updated = applyFrontmatterAdditions(withName, topAdditions, metaAdditions);
    if (!updated || updated === raw) continue;

    writeAtomic(fact.path, updated);
    changes.push({
      file: fact.file,
      added: [
        ...(nameIsWrong ? ["name (corrected to the filename)"] : []),
        ...Object.keys(topAdditions),
        ...Object.keys(metaAdditions),
      ],
    });
  }

  return changes;
}

// --- secret and anti-pattern scanning -------------------------------------------
//
// The auto-capture hook (hooks/memory-auto-capture.mjs) lets a cheap model write
// fact files from a session transcript with no human in the loop. Nothing upstream
// of this generator ever checked for a pasted secret ending up in a committed,
// always-loaded, R2-backed-up file — so it does, here, on every write (manual or
// hooked), since this is the one chokepoint every write path already passes through.
//
// High-confidence patterns are errors (block the write, same severity as a broken
// frontmatter field) because a false positive here just means re-wording a fact;
// a false negative means a real credential ships into the corpus.
const SECRET_PATTERNS = [
  { name: "AWS access key ID", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "bearer token", re: /Bearer\s+[A-Za-z0-9\-_.]{20,}/ },
];

// Lower confidence: a key/secret/token/password *assignment* with a plausible
// value. Warns instead of blocks, and skips obvious placeholders, because this
// shape alone also matches "the token field needs a non-empty value" prose.
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"]?([A-Za-z0-9/_.\-]{16,})['"]?/gi;
const PLACEHOLDER_RE = /^(<|\$|your[_-]|example|xxx|changeme|placeholder|redacted|\.\.\.)/i;

function scanForSecrets(raw) {
  const found = { blocking: [], warning: [] };
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(raw)) found.blocking.push(name);
  }
  for (const match of raw.matchAll(SECRET_ASSIGNMENT_RE)) {
    const value = match[2];
    if (!PLACEHOLDER_RE.test(value)) {
      found.warning.push(`${match[1]}=<redacted, ${value.length} chars>`);
      break; // one mention is enough to flag the file; no need to enumerate every line
    }
  }
  return found;
}

// Mechanical version of the "record only what cannot be derived" / "one fact per
// FACT, not one per work session" rule from CLAUDE.md — that rule is prose today,
// so nothing catches a session-log-shaped memory before it's indexed. Warns only:
// legitimate facts can start with a date in prose, so this is a nudge, not a gate.
const SESSION_LOG_SHAPE_RE = [
  /^\d{4}-\d{2}-\d{2}\b/, // description opens with a bare date
  /\b\d+\s+commits?\b/i, // "N commits executed/pushed/live"
  /\bcommit\s+range\b/i,
  /\b[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40}\b/, // a commit range like abc123...def456
];

function looksLikeSessionLog(description) {
  return SESSION_LOG_SHAPE_RE.some((re) => re.test(description));
}

// --- validation ---------------------------------------------------------------

function validate(facts, sections, today) {
  const errors = [];
  const warnings = [];
  const validIds = new Set(sections.map((s) => s.id));
  const limits = new Map(sections.map((s) => [s.id, s.maxChars ?? DEFAULT_MAX_DESCRIPTION_CHARS]));
  const seenNames = new Map();

  for (const fact of facts) {
    const where = fact.file;

    if (fact.parseError) {
      errors.push(`${where}: ${fact.parseError}`);
      continue;
    }

    const { name, description } = fact.data;
    const meta = fact.meta;

    if (!name) {
      errors.push(`${where}: frontmatter has no "name"`);
    } else if (name !== fact.expectedName) {
      errors.push(
        `${where}: name "${name}" does not match the filename (expected "${fact.expectedName}")`,
      );
    } else if (seenNames.has(name)) {
      errors.push(`${where}: duplicate name "${name}", already used by ${seenNames.get(name)}`);
    } else {
      seenNames.set(name, where);
    }

    if (!description || !description.trim()) {
      errors.push(
        `${where}: frontmatter has no "description" — that IS the index line, so there is nothing to index`,
      );
    } else {
      const limit = limits.get(meta.section) ?? DEFAULT_MAX_DESCRIPTION_CHARS;
      if (description.length > limit) {
        const scope = limits.has(meta.section) ? ` for section "${meta.section}"` : "";
        errors.push(
          `${where}: description is ${description.length} chars, over the ${limit}-char limit${scope} — cut it to the one fact you would regret forgetting`,
        );
      }
    }

    if (!meta.section) {
      errors.push(`${where}: metadata.section is missing (allowed: ${[...validIds].join(", ")})`);
    } else if (!validIds.has(meta.section)) {
      errors.push(
        `${where}: metadata.section "${meta.section}" is not one of: ${[...validIds].join(", ")}`,
      );
    }

    if (!meta.date) {
      errors.push(`${where}: metadata.date is missing`);
    } else if (!DATE_RE.test(meta.date)) {
      errors.push(`${where}: metadata.date "${meta.date}" is not YYYY-MM-DD`);
    }

    // Below here: real problems, but not worth blocking a memory write over.
    if (meta.type && !VALID_TYPES.includes(meta.type)) {
      warnings.push(`${where}: metadata.type "${meta.type}" is not one of: ${VALID_TYPES.join(", ")}`);
    }
    if (meta.status && !VALID_STATUSES.includes(meta.status)) {
      warnings.push(
        `${where}: metadata.status "${meta.status}" is not one of: ${VALID_STATUSES.join(", ")}`,
      );
    }
    if (meta.verify_by && !DATE_RE.test(meta.verify_by)) {
      warnings.push(
        `${where}: metadata.verify_by "${meta.verify_by}" is not YYYY-MM-DD, so staleness cannot be checked`,
      );
    }
    if (meta.status === "superseded") {
      warnings.push(`${where}: status is "superseded" — move it into archive/ so it stops spending index bytes`);
    }

    if (typeof fact.raw === "string") {
      const secrets = scanForSecrets(fact.raw);
      for (const kind of secrets.blocking) {
        errors.push(
          `${where}: looks like it contains a ${kind} — refusing to write a secret into a committed, backed-up memory file. Remove it and re-save.`,
        );
      }
      for (const hit of secrets.warning) {
        warnings.push(`${where}: possible credential-shaped value (${hit}) — double-check before this gets indexed`);
      }
    }
    if (description && looksLikeSessionLog(description)) {
      warnings.push(
        `${where}: description reads like a session log (opens with a date, or names a commit range) rather than a durable fact — see "record only what cannot be derived" in CLAUDE.md`,
      );
    }
  }

  const stale = facts
    .filter((f) => f.meta.verify_by && DATE_RE.test(f.meta.verify_by) && f.meta.verify_by < today)
    .map((f) => ({ file: f.file, due: f.meta.verify_by }));

  return { errors, warnings, stale };
}

// --- generation ----------------------------------------------------------------

function humanise(name) {
  const trailingDate = /-(\d{4}-\d{2}-\d{2})$/.exec(name);
  const withoutDate = name.replace(/-(\d{4}-\d{2}-\d{2})$/, "");
  const words = withoutDate.replace(/-/g, " ").trim();
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return trailingDate ? `${titled} — ${trailingDate[1]}` : titled;
}

// The one place an index line is spelled. Retirement decisions rank memories by
// what they cost the index, and a second, approximate copy of this shape would
// drift from the real one — which would mean ranking by a number that is not the
// number being spent.
function indexLine(fact, staleFiles) {
  const title = fact.data.title || humanise(fact.data.name || fact.expectedName);
  const flag = staleFiles && staleFiles.has(fact.file) ? "⚠ VERIFY — " : "";
  return `- [${title}](${fact.file}) — ${flag}${fact.data.description}`;
}

// What this memory actually costs the loaded index, newline included.
function indexLineBytes(fact) {
  return Buffer.byteLength(`${indexLine(fact)}\n`, "utf8");
}

function renderIndex(facts, sections, stale, archivedCount = 0) {
  const staleFiles = new Set(stale.map((s) => s.file));
  const lines = [];

  lines.push("# Memory Index");
  lines.push("");
  lines.push("<!-- GENERATED by ~/.claude/scripts/memory-index.mjs — DO NOT EDIT BY HAND.");
  lines.push("     Hand edits are erased on the next run. To add a memory, write a new");
  lines.push("     file in this directory and re-run the generator.");
  lines.push("     Search every memory, archived ones included:");
  lines.push("       node ~/.claude/scripts/memory-index.mjs --search <query> -->");
  lines.push("");
  lines.push(
    `**${facts.length} ${facts.length === 1 ? "memory" : "memories"}**` +
      (archivedCount ? ` · ${archivedCount} archived (searchable, not listed)` : "") +
      (stale.length ? ` · **${stale.length} past their verify-by date**` : " · none stale"),
  );
  lines.push("");
  lines.push("One line per memory. Detail lives in the linked file — do not re-expand it here.");
  lines.push("Keep each line to: status, commit, and the one fact you would regret forgetting.");
  lines.push("");

  if (stale.length) {
    lines.push(`> ⚠ **${stale.length} past their verify-by date.** Re-check the fact, then either move`);
    lines.push("> `verify_by` forward or correct the file. A memory nobody re-checks eventually");
    lines.push("> contradicts another one, and neither of them is flagged.");
    for (const entry of stale) lines.push(`> - \`${entry.file}\` — due ${entry.due}`);
    lines.push("");
  }

  const used = new Set();

  for (const section of sections) {
    const members = facts
      .filter((f) => f.meta.section === section.id)
      .sort((a, b) => {
        const byDate = String(b.meta.date || "").localeCompare(String(a.meta.date || ""));
        return byDate !== 0 ? byDate : a.file.localeCompare(b.file);
      });

    if (members.length === 0) continue;

    lines.push(`## ${section.title}`);
    lines.push("");
    for (const fact of members) {
      used.add(fact.file);
      lines.push(indexLine(fact, staleFiles));
    }
    lines.push("");
  }

  // Cannot normally happen: an unknown section is a hard validation error. Kept
  // so that a future bug drops a file into view rather than out of the index.
  const unplaced = facts.filter((f) => !used.has(f.file));
  if (unplaced.length) {
    lines.push("## Unplaced (no recognised section)");
    lines.push("");
    for (const fact of unplaced) {
      lines.push(`- [${fact.expectedName}](${fact.file}) — ${fact.data.description || "(no description)"}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// --- integrity ------------------------------------------------------------------

function readIndexLinks(dir) {
  const path = join(dir, INDEX_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const links = [];
  const re = /\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = re.exec(raw)) !== null) links.push(match[1]);
  return { raw, links };
}

function checkIntegrity(dir, facts) {
  const current = readIndexLinks(dir);
  if (!current) {
    return { missingIndex: true, orphans: facts.map((f) => f.file), broken: [], linkCount: 0 };
  }

  const linked = new Set(current.links);
  const onDisk = new Set(facts.map((f) => f.file));

  return {
    missingIndex: false,
    orphans: facts.filter((f) => !linked.has(f.file)).map((f) => f.file),
    broken: [...linked].filter((link) => !onDisk.has(link)),
    linkCount: current.links.length,
    raw: current.raw,
  };
}

// --- first-run git ---------------------------------------------------------------

// A silently clobbered memory is unrecoverable; the same event inside a git repo
// is a one-line `git log`. Ten seconds, once, so do it without being asked.
// No remote: these are local notes and some carry commercial detail.
/**
 * Two sessions can run the generator against one corpus at the same time — the
 * whole design assumes it, because MEMORY.md is DERIVED rather than appended, so
 * concurrent regeneration converges instead of clobbering (and writeAtomic uses a
 * pid-suffixed temp plus rename, so neither ever sees a half-written file).
 *
 * git is the exception: it takes `index.lock` for the duration of a write and
 * fails outright rather than waiting. Losing a memory to a lock contention would
 * be silent, so retry briefly instead of reporting a failure that is really just
 * "the other session got there first".
 */
function gitWithRetry(dir, args, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      const message = `${error.stderr || ""}${error.message || ""}`;
      const locked = /index\.lock|Another git process|unable to create/i.test(message);
      if (!locked || attempt >= attempts) throw error;
      // Busy-wait briefly: git holds the lock for milliseconds, and a sleep
      // dependency is not worth it for a path that runs a handful of times a day.
      const until = Date.now() + attempt * 120;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function ensureGitRepo(dir) {
  if (existsSync(join(dir, ".git"))) return null;

  // A memory folder deliberately placed inside a project's own repo (so it
  // commits and pushes with the code, for Cloud Code visibility) has no `.git`
  // of its own by design — the project's repo already covers it. `git init`
  // here anyway would nest a second repo inside the first, which git treats
  // as a broken gitlink rather than plain tracked files: the project's own
  // commits would silently stop seeing anything under this path. Detect that
  // case and defer to the outer repo instead of initialising a new one.
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    if (topLevel && topLevel !== dir) {
      return "already inside an existing git repository — deferring to it, no separate repo created here";
    }
  } catch {
    // not inside any repo at all — fall through to initialising one, as before
  }

  try {
    gitWithRetry(dir, ["init", "-q", "-b", "main"]);
    gitWithRetry(dir, ["add", "-A"]);
    gitWithRetry(dir, ["commit", "-q", "-m", "memory: initial index"]);
    return "initialised a git repository here (no remote, deliberately)";
  } catch (error) {
    // A second session winning the init race is success, not failure.
    if (existsSync(join(dir, ".git"))) return null;
    return `could not initialise git here: ${String(error.message).split("\n")[0]}`;
  }
}

// --- cold tier: search, archive, audit ------------------------------------------
//
// The index is capped on purpose, so the corpus cannot simply grow forever in the
// hot context. That only works if the cold half is genuinely reachable: retiring a
// memory into archive/ must not mean losing it. These three make the cold half
// real — search finds anything ever written, the archival hint says what should
// move, and the audit packet is what a session reads to judge the corpus as a
// whole (contradictions, duplication, rot) — judgement no script can do alone.

const SEARCH_RESULT_LIMIT = 60;
const ARCHIVE_AFTER_MONTHS = 6;

// The relaxed floor used when the index is over WARN_BYTES. NOT zero: dropping the
// floor entirely made the audit rank the memory written that same afternoon as the
// top retirement candidate, because it happened to have the longest description.
// Proposing to retire today's work is worse advice than proposing nothing — it
// teaches the reader to ignore the list. One month is short enough that a corpus
// which filled up in five weeks still has candidates, and long enough that nothing
// still warm is ever on it.
const PRESSURE_ARCHIVE_AFTER_MONTHS = 1;

// Deliberately narrow. A signal that fires on everything is a signal nobody reads.
// Bare "price" was in this list and had to come out: on real data it matched the
// filename `lib/signals/price.ts` and the feature name "SPA price harvest",
// neither of which can go stale. A money word only counts when attached to money.
const PERISHABLE_RE =
  /[€$£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:EUR|USD|GBP)\b|\bpricing\b|\btariffs?\b|\bquotas?\b|\bfree tier\b|\brate limits?\b|\bper (?:month|year)\b|\bv\d+\.\d+\b/i;

function listMemoryFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === ARCHIVE_DIR) {
        const nested = join(dir, entry.name);
        for (const inner of readdirSync(nested)) {
          if (inner.endsWith(".md")) files.push({ label: `${ARCHIVE_DIR}/${inner}`, path: join(nested, inner) });
        }
      }
      continue;
    }
    if (entry.name.endsWith(".md") && entry.name !== INDEX_FILE) {
      files.push({ label: entry.name, path: join(dir, entry.name) });
    }
  }
  return files;
}

function searchMemories(dir, query) {
  const needle = query.toLowerCase();
  const matches = [];

  for (const file of listMemoryFiles(dir)) {
    const lines = readFileSync(file.path, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      matches.push({ file: file.label, line: i + 1, text: lines[i].trim() });
      if (matches.length >= SEARCH_RESULT_LIMIT) return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

function countArchived(dir) {
  const archive = join(dir, ARCHIVE_DIR);
  if (!existsSync(archive)) return 0;
  return readdirSync(archive).filter((f) => f.endsWith(".md")).length;
}

function monthsBetween(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) return 0;
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

// Settled work, in a section nobody reads first, that has had time to go cold.
//
// The age floor alone CANNOT FIRE WHEN IT IS NEEDED. A corpus can reach the size
// limit in five weeks — the project corpus did, at 68 memories — and then every
// candidate is younger than six months and this returns nothing on the one corpus
// actually in trouble. The rule keyed on age; the pressure is volume.
//
// So once the index is over WARN_BYTES the age floor is dropped and candidates rank
// by what they cost the index, biggest first. Retiring under pressure is about
// buying headroom, and a 400-character line buys four times what a 100-character one
// does. Below the threshold nothing changes: oldest first, six months or older.
//
// Still only ever a PROPOSAL — nothing here moves a file. This corpus's own audit
// once flagged 8 memories as obvious duplicates and every one turned out distinct;
// a script acting on its own ranking would have destroyed ~24 durable facts to
// reclaim 1.4 KB.
function archivalCandidates(facts, sections, today, months = ARCHIVE_AFTER_MONTHS, indexBytes = 0) {
  const primary = sections.length ? sections[0].id : "current";
  const underPressure = indexBytes > WARN_BYTES;

  const settled = facts
    .filter((f) => f.meta.section && f.meta.section !== primary)
    .filter((f) => f.meta.status === "deployed");

  const olderThan = (floor) =>
    settled.filter((f) => f.meta.date && monthsBetween(f.meta.date, today) >= floor);

  return (underPressure ? olderThan(PRESSURE_ARCHIVE_AFTER_MONTHS) : olderThan(months))
    .map((f) => ({
      file: f.file,
      date: f.meta.date,
      section: f.meta.section,
      bytes: indexLineBytes(f),
    }))
    .sort((a, b) =>
      underPressure ? b.bytes - a.bytes : String(a.date || "").localeCompare(String(b.date || "")),
    );
}

function perishableWithoutVerify(facts) {
  return facts
    .filter((f) => !f.meta.verify_by)
    .filter((f) => f.meta.type === "reference" || PERISHABLE_RE.test(String(f.data.description || "")))
    .map((f) => ({
      file: f.file,
      why: f.meta.type === "reference" ? "type: reference" : "mentions a figure that moves",
    }));
}

// The packet a session reads to judge the corpus. Descriptions only — the whole
// point is that it stays small enough to reason over in one pass.
function auditPacket(dir, facts, sections, today) {
  const stale = facts.filter((f) => f.meta.verify_by && f.meta.verify_by < today);
  const perishable = perishableWithoutVerify(facts);
  const archived = countArchived(dir);

  // Measured from the index this corpus would actually generate, not estimated —
  // the pressure rule below only means anything if the number it keys on is the
  // number that gets loaded.
  const indexSize = loadedIndexSize(
    renderIndex(
      facts,
      sections,
      stale.map((f) => ({ file: f.file, due: f.meta.verify_by })),
      archived,
    ),
  );
  const indexBytes = indexSize.bytes;
  const underPressure = indexBytes > WARN_BYTES || indexSize.lines > WARN_LINES;
  const archival = archivalCandidates(facts, sections, today, ARCHIVE_AFTER_MONTHS, indexBytes);
  const lines = [];

  lines.push(`# Memory audit packet — ${facts.length} memories, ${archived} archived, generated for ${today}`);
  lines.push("");
  lines.push("Each entry: [section] date status filename, then its index line.");
  lines.push("");

  for (const section of sections) {
    const members = facts
      .filter((f) => f.meta.section === section.id)
      .sort((a, b) => String(b.meta.date || "").localeCompare(String(a.meta.date || "")));
    if (!members.length) continue;

    lines.push(`## ${section.title}`);
    for (const fact of members) {
      lines.push(
        `[${fact.meta.section}] ${fact.meta.date || "no-date"} ${fact.meta.status || "no-status"} ${fact.file}`,
      );
      lines.push(`    ${fact.data.description || "(no description)"}`);
    }
    lines.push("");
  }

  lines.push("## Mechanical findings (already computed — do not re-derive)");
  lines.push("");
  lines.push(`- past verify_by: ${stale.length ? stale.map((f) => f.file).join(", ") : "none"}`);
  lines.push(
    `- perishable but no verify_by: ${perishable.length ? perishable.map((p) => `${p.file} (${p.why})`).join(", ") : "none"}`,
  );
  if (underPressure) {
    // Under pressure the list is ranked by index cost, so it is worth showing the
    // cost — otherwise the ordering looks arbitrary and gets read as arbitrary.
    lines.push(
      `- index is ${(indexBytes / 1024).toFixed(1)} KB of the ${(FAIL_BYTES / 1024).toFixed(0)} KB limit — ` +
        `RETIREMENT IS THE PRIORITY OF THIS AUDIT. Candidates below relax the ${ARCHIVE_AFTER_MONTHS}-month ` +
        `floor to ${PRESSURE_ARCHIVE_AFTER_MONTHS} (nothing here is six months old yet) and are ranked by ` +
        `what they cost the index:`,
    );
    lines.push(
      `- archival candidates (settled, not in the first section), biggest first: ` +
        `${archival.length ? archival.map((a) => `${a.file} (${a.bytes}B)`).join(", ") : "none"}`,
    );
  } else {
    lines.push(
      `- archival candidates (settled, ${ARCHIVE_AFTER_MONTHS}+ months, not in the first section): ` +
        `${archival.length ? archival.map((a) => a.file).join(", ") : "none"}`,
    );
  }
  lines.push("");
  lines.push("## What a script cannot decide — this is the actual job");
  lines.push("");
  lines.push("1. CONTRADICTIONS: which pairs assert incompatible things? Age does not catch this;");
  lines.push("   two memories can disagree from the day they are written. Name the pair and say");
  lines.push("   which one today's evidence supports.");
  lines.push("2. SUPERSEDED: which memories were quietly overtaken by a later one?");
  lines.push("3. DUPLICATION: which pairs say substantially the same thing and should be merged?");
  lines.push("4. DERIVABLE: which record something git, the database or the code could answer");
  lines.push("   on demand, and so should never have been memory?");
  lines.push("");
  lines.push("Report findings. Do not edit or delete any memory without the owner agreeing first.");

  return lines.join("\n");
}

// --- main ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = { check: false, dir: null, help: false, noMigrate: false, audit: false, search: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--no-migrate") options.noMigrate = true;
    else if (arg === "--audit") options.audit = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dir") options.dir = argv[++i];
    else if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg === "--search") options.search = argv[++i];
    else if (arg.startsWith("--search=")) options.search = arg.slice("--search=".length);
    else throw new Error(`unknown argument "${arg}" (try --help)`);
  }
  if (options.dir === undefined || (options.dir !== null && !options.dir)) {
    throw new Error("--dir needs a path");
  }
  if (options.search === undefined || (options.search !== null && !options.search)) {
    throw new Error("--search needs a query");
  }
  return options;
}

const USAGE = `memory-index.mjs — generate MEMORY.md from the fact-files beside it

  node ~/.claude/scripts/memory-index.mjs                regenerate for the current project
  node ~/.claude/scripts/memory-index.mjs --check        validate only, write nothing
  node ~/.claude/scripts/memory-index.mjs --dir <path>   use an explicit memory directory
  node ~/.claude/scripts/memory-index.mjs --no-migrate   do not upgrade old fact-files
  node ~/.claude/scripts/memory-index.mjs --search <q>   search every memory, archive included
  node ~/.claude/scripts/memory-index.mjs --audit        print the corpus review packet

--search reaches archived memories that the index deliberately leaves out, which
is what makes archiving safe. --audit prints what a session needs to judge the
corpus as a whole; see the memory-audit skill.

Fact-files predating the frontmatter contract are upgraded in place on the first
run: missing section/date/status/title are inferred and spliced in, and nothing
already written is touched. --check never migrates.

Exits non-zero on a validation failure or an oversized index.
Contract and rationale: ~/.claude/MEMORY_SYSTEM_PLAN.md`;

// Which section is eating the index? Without this the only actionable advice is
// "something is too long", which is not advice.
function sectionUsage(facts, sections) {
  return sections
    .map((section) => {
      const members = facts.filter((f) => f.meta.section === section.id);
      const bytes = members.reduce(
        (total, f) => total + Buffer.byteLength(String(f.data.description || ""), "utf8"),
        0,
      );
      return { id: section.id, count: members.length, bytes, maxChars: section.maxChars };
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

function reportSizeFailure(facts, sections, kilobytes, size) {
  const overLines = size && size.lines > FAIL_LINES;
  console.error(
    overLines
      ? `FAIL  index would be ${size.lines} lines, over the ${FAIL_LINES}-line limit (${kilobytes} KB).`
      : `FAIL  index would be ${kilobytes} KB, over the ${(FAIL_BYTES / 1024).toFixed(0)} KB limit.`,
  );
  console.error(
    `      Claude Code loads the first ${NATIVE_MAX_LINES} lines OR ` +
      `${(NATIVE_MAX_BYTES / 1024).toFixed(0)} KB, whichever comes first, and drops the rest silently.`,
  );
  console.error("      Spent per section:");
  for (const row of sectionUsage(facts, sections)) {
    console.error(
      `        ${(row.bytes / 1024).toFixed(1).padStart(5)} KB  ${String(row.count).padStart(3)} entries  ` +
        `${row.id} (limit ${row.maxChars}/line)`,
    );
  }
  console.error("      Longest descriptions, shorten these first:");
  const longest = [...facts]
    .filter((f) => f.data.description)
    .sort((a, b) => b.data.description.length - a.data.description.length)
    .slice(0, 8);
  for (const fact of longest) {
    console.error(`        ${String(fact.data.description.length).padStart(4)}  ${fact.file}`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const dir = options.dir || defaultMemoryDir(process.cwd());

  // Running the generator from INSIDE a corpus resolves to a corpus *of the corpus*.
  // This has to be caught before the existence check, not after: the first such run
  // CREATES the phantom directory, so every run afterwards finds it, indexes zero
  // files and prints a cheerful "OK 0.5 KB" for a corpus that is not yours. It
  // happened here on 2026-08-01. Refuse, and name the directory that was meant.
  if (!options.dir && basename(process.cwd()) === "memory") {
    console.error("You are inside a memory directory. Indexing here would build a corpus of the");
    console.error("corpus — a decoy that quietly absorbs the memories you meant to write.");
    console.error(`cd to the project this belongs to and re-run, or: --dir ${process.cwd()}`);
    process.exit(2);
  }

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`No memory directory at ${dir}`);
    console.error("Nothing to index. Write a fact-file there first, or pass --dir.");
    process.exit(2);
  }

  // Read-only modes run before anything else so they can never trigger a write,
  // and print only their own output so the result stays pipeable.
  if (options.search !== null) {
    const { matches, truncated } = searchMemories(dir, options.search);
    for (const match of matches) console.log(`${match.file}:${match.line}  ${match.text}`);
    if (truncated) console.log(`… stopped at ${SEARCH_RESULT_LIMIT} matches; narrow the query`);
    if (!matches.length) console.log(`no memory mentions "${options.search}"`);
    return;
  }

  if (!options.audit) console.log(`memory dir: ${dir}`);

  let sectionConfig;
  try {
    sectionConfig = loadSections(dir);
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    process.exit(1);
  }
  const { sections, source } = sectionConfig;
  if (!options.audit) console.log(`sections:   ${sections.map((s) => s.id).join(", ")}  (${source})`);

  let facts = readFacts(dir);

  if (options.audit) {
    console.log(auditPacket(dir, facts, sections, new Date().toISOString().slice(0, 10)));
    return;
  }

  // Before validating, bring any pre-contract files up to the contract. Skipped
  // under --check, which must never write, and skippable with --no-migrate.
  if (!options.check && !options.noMigrate) {
    const changes = migrate(dir, facts, sections);
    if (changes.length) {
      console.log(`migrated:   ${changes.length} file(s) upgraded to the frontmatter contract`);
      for (const change of changes.slice(0, 8)) {
        console.log(`            ${change.file}: added ${change.added.join(", ")}`);
      }
      if (changes.length > 8) console.log(`            … and ${changes.length - 8} more`);
      facts = readFacts(dir);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const { errors, warnings, stale } = validate(facts, sections, today);
  const integrity = checkIntegrity(dir, facts);

  console.log(`fact-files: ${facts.length}`);

  for (const warning of warnings) console.log(`WARN  ${warning}`);
  for (const error of errors) console.error(`FAIL  ${error}`);

  const rendered = renderIndex(facts, sections, stale, countArchived(dir));
  // Measure what Claude Code actually loads — frontmatter and block comments are
  // stripped before its limits apply, and LINES bind before bytes on a corpus of
  // many short entries.
  const size = loadedIndexSize(rendered);
  const bytes = size.bytes;
  const kilobytes = (bytes / 1024).toFixed(1);

  // Only the fact-files can block a write. Orphans and broken links describe the
  // OLD index, and regenerating is what repairs them — a freshly derived index
  // cannot contain either, by construction. Blocking on them would mean the tool
  // that fixes a damaged index refuses to run whenever the index is damaged.
  let failed = errors.length > 0;

  if (bytes > FAIL_BYTES || size.lines > FAIL_LINES) {
    reportSizeFailure(facts, sections, kilobytes, size);
    failed = true;
  } else if (bytes > WARN_BYTES || size.lines > WARN_LINES) {
    // One line only. The per-section breakdown belongs to the FAIL path: an
    // advisory that prints six lines on every healthy run stops being read,
    // which is the failure this whole system exists to avoid.
    // Name whichever dimension is closer to its limit — "17 KB of 22" is useless
    // advice when it is the line count that is about to cut the index off.
    const byteRoom = FAIL_BYTES - bytes;
    const lineRoom = FAIL_LINES - size.lines;
    const linesBind = lineRoom / FAIL_LINES < byteRoom / FAIL_BYTES;
    console.log(
      linesBind
        ? `WARN  index is ${size.lines} lines — ${lineRoom} before the ${FAIL_LINES}-line hard limit. --audit shows what to retire.`
        : `WARN  index is ${kilobytes} KB — ${(byteRoom / 1024).toFixed(1)} KB of headroom before the ${(FAIL_BYTES / 1024).toFixed(0)} KB hard limit. --audit shows what to retire.`,
    );
  }

  if (options.check) {
    if (integrity.missingIndex) {
      console.error(`FAIL  no ${INDEX_FILE} — run without --check to generate it`);
      failed = true;
    } else {
      for (const orphan of integrity.orphans) {
        console.error(`FAIL  ${orphan} exists on disk but no ${INDEX_FILE} line points at it`);
      }
      for (const link of integrity.broken) {
        console.error(`FAIL  ${INDEX_FILE} links to ${link}, which does not exist`);
      }
      if (integrity.orphans.length || integrity.broken.length) failed = true;

      console.log(
        `check:      ${facts.length} files in, ${integrity.linkCount} index links out, ` +
          `${integrity.orphans.length} orphans, ${integrity.broken.length} broken`,
      );
      if (!failed && integrity.raw !== rendered) {
        console.log(`WARN  ${INDEX_FILE} differs from what would be generated — re-run without --check`);
      }
    }
    if (failed) process.exit(1);
    console.log(`OK    ${kilobytes} KB, ${stale.length} stale`);
    return;
  }

  if (failed) {
    console.error("");
    console.error("Nothing written. Fix the failures above, then re-run.");
    process.exit(1);
  }

  const indexPath = join(dir, INDEX_FILE);
  const unchanged = existsSync(indexPath) && readFileSync(indexPath, "utf8") === rendered;
  if (unchanged) {
    console.log(`OK    ${INDEX_FILE} already current — ${kilobytes} KB, ${stale.length} stale`);
  } else {
    writeAtomic(indexPath, rendered);
    console.log(`OK    wrote ${INDEX_FILE} — ${facts.length} entries, ${kilobytes} KB, ${stale.length} stale`);
  }

  const gitNote = ensureGitRepo(dir);
  if (gitNote) console.log(`git:  ${gitNote}`);

  if (stale.length) {
    console.log("");
    console.log(`${stale.length} past verify-by: ${stale.map((s) => s.file).join(", ")}`);
  }

  // One line, never a list. A nudge repeated per-file every run becomes wallpaper,
  // and the whole point is that this one still gets read in six months.
  const perishable = perishableWithoutVerify(facts);
  if (perishable.length) {
    const one = perishable.length === 1;
    console.log(
      `note: ${perishable.length} memor${one ? "y looks" : "ies look"} perishable but ` +
        `${one ? "carries" : "carry"} no verify_by — see --audit`,
    );
  }

  // Passing `bytes` is what lets this fire while the corpus is still young: over the
  // warn threshold, "settled" stops meaning "six months old" and starts meaning
  // "costing index bytes we no longer have".
  const archival = archivalCandidates(facts, sections, today, ARCHIVE_AFTER_MONTHS, bytes);
  if (archival.length) {
    const reclaimable = archival.reduce((sum, a) => sum + a.bytes, 0);
    console.log(
      `note: ${archival.length} settled memor${archival.length === 1 ? "y" : "ies"} could move to archive/ ` +
        `(${(reclaimable / 1024).toFixed(1)} KB of index) — see --audit`,
    );
  }
}

// Only run as a CLI. Importing the module (from the test suite) must not execute
// anything — otherwise `node --test` would try to index the test runner's cwd.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) main();

export {
  parseFrontmatter,
  stripComment,
  unquote,
  slugForPath,
  defaultMemoryDir,
  loadSections,
  readFacts,
  validate,
  renderIndex,
  humanise,
  matchSection,
  normaliseHeading,
  inferDate,
  inferStatus,
  formatScalar,
  applyFrontmatterAdditions,
  readIndexEntries,
  checkIntegrity,
  migrate,
  sectionUsage,
  writeAtomic,
  listMemoryFiles,
  searchMemories,
  countArchived,
  monthsBetween,
  archivalCandidates,
  perishableWithoutVerify,
  auditPacket,
  ARCHIVE_DIR,
  DEFAULT_MAX_DESCRIPTION_CHARS,
  FALLBACK_SECTIONS,
  WARN_BYTES,
  FAIL_BYTES,
  WARN_LINES,
  FAIL_LINES,
  NATIVE_MAX_BYTES,
  NATIVE_MAX_LINES,
};
