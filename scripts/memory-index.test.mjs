// Tests for memory-index.mjs. No dependencies — node:test is built in.
//
//   node --test ~/.claude/scripts/
//
// This script governs memory for EVERY project on this machine, and its failure
// mode is silence: a memory that never reaches the index is not an error anyone
// sees, it is a fact you no longer have. So the suite leans on the paths where
// silence would be the symptom — migration preserving what it did not write, the
// validator actually rejecting, and --check never touching disk.
//
// Every fixture lives in a fresh temp directory. Nothing here reads or writes a
// real memory file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseFrontmatter,
  stripComment,
  unquote,
  slugForPath,
  validate,
  renderIndex,
  humanise,
  matchSection,
  inferDate,
  inferStatus,
  formatScalar,
  applyFrontmatterAdditions,
  readIndexEntries,
  checkIntegrity,
  migrate,
  sectionUsage,
  loadSections,
  readFacts,
  searchMemories,
  countArchived,
  monthsBetween,
  archivalCandidates,
  perishableWithoutVerify,
  auditPacket,
  DEFAULT_MAX_DESCRIPTION_CHARS,
  FAIL_BYTES,
  FAIL_LINES,
  NATIVE_MAX_BYTES,
  NATIVE_MAX_LINES,
  loadedIndexSize,
  projectRootFor,
} from "./memory-index.mjs";

const SCRIPT = fileURLToPath(new URL("./memory-index.mjs", import.meta.url));
const SECTIONS = [
  { id: "current", title: "Current state (read these first)", maxChars: 400 },
  { id: "ui", title: "UI / front-end", maxChars: 240 },
];

// --- helpers -------------------------------------------------------------------

function scratch() {
  return mkdtempSync(join(tmpdir(), "memidx-"));
}

function fact(dir, name, frontmatter, body = "body text\n") {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
  return path;
}

function conformingFact(dir, name, overrides = {}) {
  const meta = { type: "project", section: "current", date: "2026-08-01", ...overrides };
  const lines = Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`);
  return fact(dir, name, `name: ${name}\ndescription: "A fact worth keeping."\nmetadata:\n${lines.join("\n")}`);
}

// Runs the real CLI, so argument parsing and exit codes are exercised too.
function cli(args, cwd) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      ...(cwd ? { cwd } : {}),
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

const bodyOf = (text) => text.split("\n---\n").slice(1).join("\n---\n");

// --- frontmatter parsing ---------------------------------------------------------

describe("parseFrontmatter", () => {
  test("reads a double-quoted scalar containing a colon and an em dash", () => {
    const { data } = parseFrontmatter('---\nname: a\ndescription: "Has: a colon — and a dash"\n---\nbody');
    assert.equal(data.description, "Has: a colon — and a dash");
  });

  test("folds a >- block scalar onto one line", () => {
    const { data } = parseFrontmatter("---\nname: a\ndescription: >-\n  first line\n  second line\n---\nbody");
    assert.equal(data.description, "first line second line");
  });

  test("keeps newlines in a | block scalar", () => {
    const { data } = parseFrontmatter("---\nname: a\nnote: |\n  one\n  two\n---\nbody");
    assert.equal(data.note, "one\ntwo");
  });

  test("reads a nested metadata map", () => {
    const { data } = parseFrontmatter("---\nname: a\nmetadata:\n  type: project\n  section: current\n---\nbody");
    assert.deepEqual(data.metadata, { type: "project", section: "current" });
  });

  test("tolerates the trailing space after 'metadata:' that real files have", () => {
    const { data } = parseFrontmatter("---\nname: a\nmetadata: \n  type: project\n---\nbody");
    assert.equal(data.metadata.type, "project");
  });

  test("a block scalar does not swallow the key that follows it", () => {
    const { data } = parseFrontmatter("---\ndescription: >-\n  folded\nname: after\n---\nbody");
    assert.equal(data.description, "folded");
    assert.equal(data.name, "after");
  });

  test("reports a missing frontmatter block", () => {
    assert.match(parseFrontmatter("no frontmatter here").error, /no frontmatter/);
  });

  test("reports an unclosed frontmatter block", () => {
    assert.match(parseFrontmatter("---\nname: a\nstill going").error, /never closed/);
  });

  test("unquote handles escaped quotes and leaves bare values alone", () => {
    assert.equal(unquote('"say \\"hi\\""'), 'say "hi"');
    assert.equal(unquote("'single'"), "single");
    assert.equal(unquote("bare"), "bare");
  });

  test("strips an inline comment from an unquoted value", () => {
    const { data } = parseFrontmatter("---\nname: a\nmetadata:\n  section: current   # must exist\n---\nbody");
    assert.equal(data.metadata.section, "current");
  });

  test("keeps a # that lives inside a quoted string", () => {
    assert.equal(stripComment('"channel #project"'), '"channel #project"');
    assert.equal(stripComment("'tag #1'"), "'tag #1'");
  });

  test("keeps a # that is part of a word", () => {
    assert.equal(stripComment("issue#42"), "issue#42");
  });

  test("a block-scalar marker still works when followed by a comment", () => {
    const { data } = parseFrontmatter("---\ndescription: >-   # the index line\n  folded text\n---\nbody");
    assert.equal(data.description, "folded text");
  });

  test("the commented template in ~/.claude/CLAUDE.md parses to clean values", () => {
    const template = [
      "---",
      "name: example-2026-08-01                  # == filename, minus .md",
      "title: Example — 2026-08-01               # optional",
      "description: >-                           # THIS BECOMES THE INDEX LINE",
      "  The one fact you would regret forgetting.",
      "metadata:",
      "  type: project                           # user | feedback | project | reference",
      "  section: current                        # must exist in sections.json",
      "  date: 2026-08-01                        # when the fact was established",
      "---",
      "body",
    ].join("\n");
    const { data } = parseFrontmatter(template);
    assert.equal(data.name, "example-2026-08-01");
    assert.equal(data.description, "The one fact you would regret forgetting.");
    assert.equal(data.metadata.type, "project");
    assert.equal(data.metadata.section, "current");
    assert.equal(data.metadata.date, "2026-08-01");
  });
});

// --- path derivation ---------------------------------------------------------------

describe("slugForPath", () => {
  test("turns every non-alphanumeric character into a hyphen", () => {
    assert.equal(slugForPath("/Users/x/Documents/project"), "-Users-x-Documents-project");
  });

  test("a dot and a slash each produce their own hyphen", () => {
    assert.equal(slugForPath("/Users/x/.claude/jobs"), "-Users-x--claude-jobs");
  });

  test("preserves case and existing hyphens", () => {
    assert.equal(slugForPath("/a/NEW-example-bot"), "-a-NEW-example-bot");
  });
});

// --- inference used by migration ------------------------------------------------

describe("matchSection", () => {
  test("matches a heading to a section by exact title", () => {
    assert.equal(matchSection("Current state (read these first)", SECTIONS), "current");
  });

  test("matches by token when the title differs, e.g. 'SEO / GEO / AEO' -> seo", () => {
    const sections = [{ id: "current", title: "C" }, { id: "seo", title: "Search" }];
    assert.equal(matchSection("SEO / GEO / AEO", sections), "seo");
  });

  test("matches 'UI / front-end' to ui without matching ui inside another word", () => {
    assert.equal(matchSection("UI / front-end", SECTIONS), "ui");
    assert.equal(matchSection("Build guide", SECTIONS), "current", "'build' must not match 'ui'");
  });

  test("falls back to the first section when the heading is unknown or absent", () => {
    assert.equal(matchSection("Something else entirely", SECTIONS), "current");
    assert.equal(matchSection(null, SECTIONS), "current");
  });
});

describe("inferStatus", () => {
  test("unmerged work outranks the word DEPLOYED on the same line", () => {
    assert.equal(inferStatus("`abc` DEPLOYED to preview but NOT MERGED to main"), "committed-not-pushed");
  });

  test("NOT COMMITTED is the opposite of committed-not-pushed, not a synonym", () => {
    // This mislabelled three real memories before an audit caught it.
    assert.equal(inferStatus("TDD, reviewed, NOT committed"), "uncommitted");
    assert.equal(inferStatus("scripts/build.mjs UNCOMMITTED, 23 tests"), "uncommitted");
  });

  test("pushed but unmerged is its own state", () => {
    assert.equal(
      inferStatus("on branch b2b-backup, PUSHED to GitHub 2026-08-01 but NOT merged to main"),
      "pushed-not-merged",
    );
  });

  test("recognises deployed, plan-only, and nothing at all", () => {
    assert.equal(inferStatus("`abc` **DEPLOYED**, 3189 tests"), "deployed");
    assert.equal(inferStatus("plan only, nothing built"), "plan-only");
    assert.equal(inferStatus("just some prose"), null);
    assert.equal(inferStatus(""), null);
  });
});

describe("inferDate", () => {
  test("prefers a date carried by the filename", () => {
    const dir = scratch();
    const path = conformingFact(dir, "topic-2026-07-14");
    assert.equal(inferDate({ expectedName: "topic-2026-07-14", meta: {}, path }), "2026-07-14");
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to metadata.modified", () => {
    const dir = scratch();
    const path = conformingFact(dir, "no-date");
    assert.equal(inferDate({ expectedName: "no-date", meta: { modified: "2026-03-04T10:00:00.000Z" }, path }), "2026-03-04");
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to file mtime when nothing else is available", () => {
    const dir = scratch();
    const path = conformingFact(dir, "bare");
    const when = new Date("2025-12-25T12:00:00Z");
    utimesSync(path, when, when);
    assert.equal(inferDate({ expectedName: "bare", meta: {}, path }), "2025-12-25");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("formatScalar", () => {
  test("leaves a date and a plain word unquoted", () => {
    assert.equal(formatScalar("2026-08-01"), "2026-08-01");
    assert.equal(formatScalar("deployed"), "deployed");
  });

  test("quotes anything containing a colon, so YAML cannot misread it", () => {
    assert.equal(formatScalar("RULE: notify"), '"RULE: notify"');
  });

  test("escapes embedded double quotes", () => {
    assert.equal(formatScalar('a "quoted" word'), '"a \\"quoted\\" word"');
  });
});

// --- surgical frontmatter editing ---------------------------------------------------

describe("applyFrontmatterAdditions", () => {
  const original = [
    "---",
    "name: thing",
    'description: "hook"',
    "metadata: ",
    "  node_type: memory",
    "  type: project",
    "  originSessionId: abc-123",
    "---",
    "",
    "# Body",
    "prose that must not move",
    "",
  ].join("\n");

  test("appends to an existing metadata block without disturbing what is there", () => {
    const updated = applyFrontmatterAdditions(original, {}, { section: "current", date: "2026-08-01" });
    assert.match(updated, /^ {2}section: current$/m);
    assert.match(updated, /^ {2}date: 2026-08-01$/m);
    assert.match(updated, /^ {2}originSessionId: abc-123$/m, "provenance must survive");
    assert.match(updated, /^prose that must not move$/m);
  });

  test("inserts a top-level title directly after name", () => {
    const lines = applyFrontmatterAdditions(original, { title: "A Title" }, {}).split("\n");
    assert.equal(lines[1], "name: thing");
    assert.equal(lines[2], "title: A Title");
  });

  test("creates a metadata block when the file has none", () => {
    const bare = "---\nname: thing\ndescription: hook\n---\n\nbody\n";
    const updated = applyFrontmatterAdditions(bare, {}, { section: "current" });
    assert.match(updated, /^metadata:$/m);
    assert.equal(parseFrontmatter(updated).data.metadata.section, "current");
  });

  test("the body is byte-identical after an addition", () => {
    const updated = applyFrontmatterAdditions(original, { title: "T" }, { section: "current" });
    assert.equal(bodyOf(updated), bodyOf(original));
  });

  test("returns null rather than guessing when there is no frontmatter", () => {
    assert.equal(applyFrontmatterAdditions("no frontmatter", {}, { section: "current" }), null);
  });

  test("round-trips through the parser", () => {
    const updated = applyFrontmatterAdditions(original, { title: "Round: trip" }, { date: "2026-08-01" });
    const { data } = parseFrontmatter(updated);
    assert.equal(data.title, "Round: trip");
    assert.equal(data.metadata.date, "2026-08-01");
    assert.equal(data.metadata.originSessionId, "abc-123");
  });
});

// --- validation ---------------------------------------------------------------------

describe("validate", () => {
  const today = "2026-08-01";

  function check(overrides, frontmatterOverride) {
    const dir = scratch();
    if (frontmatterOverride) fact(dir, "sample", frontmatterOverride);
    else conformingFact(dir, "sample", overrides);
    const result = validate(readFacts(dir), SECTIONS, today);
    rmSync(dir, { recursive: true, force: true });
    return result;
  }

  test("accepts a conforming file", () => {
    assert.deepEqual(check({}).errors, []);
  });

  test("rejects a name that does not match the filename", () => {
    const { errors } = check({}, 'name: other\ndescription: "d"\nmetadata:\n  section: current\n  date: 2026-08-01');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /does not match the filename/);
  });

  test("rejects a missing description, naming the file", () => {
    const { errors } = check({}, "name: sample\nmetadata:\n  section: current\n  date: 2026-08-01");
    assert.match(errors.join(" "), /sample\.md.*no "description"/);
  });

  test("rejects a missing section and a missing date", () => {
    const { errors } = check({}, 'name: sample\ndescription: "d"\nmetadata:\n  type: project');
    assert.equal(errors.filter((e) => /section is missing/.test(e)).length, 1);
    assert.equal(errors.filter((e) => /date is missing/.test(e)).length, 1);
  });

  test("rejects a section that is not configured", () => {
    assert.match(check({ section: "nonsense" }).errors.join(" "), /"nonsense" is not one of: current, ui/);
  });

  test("rejects a malformed date", () => {
    assert.match(check({ date: "01-08-2026" }).errors.join(" "), /is not YYYY-MM-DD/);
  });

  test("applies the per-section character limit, not one global limit", () => {
    const long = "x".repeat(300);
    const dir = scratch();
    fact(dir, "a", `name: a\ndescription: "${long}"\nmetadata:\n  section: current\n  date: 2026-08-01`);
    fact(dir, "b", `name: b\ndescription: "${long}"\nmetadata:\n  section: ui\n  date: 2026-08-01`);
    const { errors } = validate(readFacts(dir), SECTIONS, today);
    rmSync(dir, { recursive: true, force: true });

    // 300 chars fits `current` (400) and busts `ui` (240).
    assert.equal(errors.length, 1);
    assert.match(errors[0], /b\.md/);
    assert.match(errors[0], /240-char limit for section "ui"/);
  });

  test("catches two files claiming the same name", () => {
    const dir = scratch();
    fact(dir, "a", 'name: a\ndescription: "d"\nmetadata:\n  section: current\n  date: 2026-08-01');
    fact(dir, "b", 'name: a\ndescription: "d"\nmetadata:\n  section: current\n  date: 2026-08-01');
    const { errors } = validate(readFacts(dir), SECTIONS, today);
    rmSync(dir, { recursive: true, force: true });
    assert.match(errors.join(" "), /duplicate name|does not match the filename/);
  });

  test("flags a past verify_by as stale, and a future one as fine", () => {
    const dir = scratch();
    conformingFact(dir, "old", { verify_by: "2026-01-01" });
    conformingFact(dir, "new", { verify_by: "2099-01-01" });
    const { stale, errors } = validate(readFacts(dir), SECTIONS, today);
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(stale.map((s) => s.file), ["old.md"]);
  });

  test("warns, without failing, on an unknown type and an unarchived superseded memory", () => {
    const { errors, warnings } = check({ type: "gotcha", status: "superseded" });
    assert.deepEqual(errors, []);
    assert.match(warnings.join(" "), /type "gotcha"/);
    assert.match(warnings.join(" "), /move it into archive/);
  });
});

// --- rendering -------------------------------------------------------------------------

describe("renderIndex", () => {
  function build(dir) {
    conformingFact(dir, "newest", { date: "2026-08-01" });
    conformingFact(dir, "oldest", { date: "2026-01-01" });
    conformingFact(dir, "uithing", { section: "ui", date: "2026-05-05" });
    return readFacts(dir);
  }

  test("groups by section in configured order and sorts newest first", () => {
    const dir = scratch();
    const output = renderIndex(build(dir), SECTIONS, []);
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(output.match(/^## .*$/gm), ["## Current state (read these first)", "## UI / front-end"]);
    assert.ok(output.indexOf("newest.md") < output.indexOf("oldest.md"), "newest must come first");
  });

  test("states the count and carries the DO-NOT-EDIT banner", () => {
    const dir = scratch();
    const output = renderIndex(build(dir), SECTIONS, []);
    rmSync(dir, { recursive: true, force: true });
    assert.match(output, /\*\*3 memories\*\*/);
    assert.match(output, /DO NOT EDIT BY HAND/);
  });

  test("marks stale entries inline and summarises them at the top", () => {
    const dir = scratch();
    const output = renderIndex(build(dir), SECTIONS, [{ file: "oldest.md", due: "2026-02-01" }]);
    rmSync(dir, { recursive: true, force: true });
    assert.match(output, /1 past their verify-by date/);
    assert.match(output, /- \[.*\]\(oldest\.md\) — ⚠ VERIFY —/);
  });

  test("humanises a name when no title is given", () => {
    assert.equal(humanise("myproject-backups-2026-07-30"), "Myproject backups — 2026-07-30");
    assert.equal(humanise("simple-name"), "Simple name");
  });

  test("every fact reaches the output, even with an unrecognised section", () => {
    const dir = scratch();
    conformingFact(dir, "stray", { section: "not-configured" });
    const output = renderIndex(readFacts(dir), SECTIONS, []);
    rmSync(dir, { recursive: true, force: true });
    assert.match(output, /Unplaced/);
    assert.match(output, /stray\.md/);
  });
});

// --- integrity + usage --------------------------------------------------------------------

describe("integrity", () => {
  test("reads titles, headings and text out of a hand-written index", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "MEMORY.md"),
      "# Memory Index\n\n## UI / front-end\n\n- [**Bold Title**](thing.md) — `abc` **DEPLOYED**, works\n",
      "utf8",
    );
    const entry = readIndexEntries(dir).get("thing.md");
    rmSync(dir, { recursive: true, force: true });

    assert.equal(entry.title, "Bold Title", "markdown bold must be stripped");
    assert.equal(entry.heading, "UI / front-end");
    assert.match(entry.text, /DEPLOYED/);
  });

  test("finds an orphan on disk and a link pointing nowhere", () => {
    const dir = scratch();
    conformingFact(dir, "present");
    writeFileSync(join(dir, "MEMORY.md"), "- [Ghost](missing.md) — nope\n", "utf8");
    const result = checkIntegrity(dir, readFacts(dir));
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(result.orphans, ["present.md"]);
    assert.deepEqual(result.broken, ["missing.md"]);
  });

  test("sectionUsage attributes bytes to the section spending them", () => {
    const dir = scratch();
    conformingFact(dir, "a");
    conformingFact(dir, "b", { section: "ui" });
    const usage = sectionUsage(readFacts(dir), SECTIONS);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(usage.length, 2);
    assert.ok(usage.every((row) => row.bytes > 0 && row.count === 1));
  });
});

// --- sections.json ----------------------------------------------------------------------

describe("loadSections", () => {
  test("falls back to generic sections when there is no config", () => {
    const dir = scratch();
    const { sections, source } = loadSections(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(source, "fallback");
    assert.equal(sections[0].id, "current");
    assert.equal(sections[0].maxChars, DEFAULT_MAX_DESCRIPTION_CHARS);
  });

  test("reads per-section and default character limits", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "sections.json"),
      JSON.stringify({
        defaultMaxChars: 180,
        sections: [{ id: "current", title: "C", maxChars: 400 }, { id: "ui", title: "U" }],
      }),
      "utf8",
    );
    const { sections } = loadSections(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(sections[0].maxChars, 400);
    assert.equal(sections[1].maxChars, 180, "unset sections inherit defaultMaxChars");
  });

  test("rejects a nonsensical limit rather than silently ignoring it", () => {
    const dir = scratch();
    writeFileSync(join(dir, "sections.json"), JSON.stringify({ sections: [{ id: "a", maxChars: 5 }] }), "utf8");
    assert.throws(() => loadSections(dir), /between 40 and/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects malformed JSON loudly", () => {
    const dir = scratch();
    writeFileSync(join(dir, "sections.json"), "{ not json", "utf8");
    assert.throws(() => loadSections(dir), /not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- migration ---------------------------------------------------------------------------

describe("migrate", () => {
  function legacyProject() {
    const dir = scratch();
    writeFileSync(
      join(dir, "old-thing.md"),
      [
        "---",
        "name: old-thing",
        'description: "A legacy memory."',
        "metadata: ",
        "  node_type: memory",
        "  type: project",
        "  originSessionId: sess-999",
        "  modified: 2026-04-05T09:00:00.000Z",
        "---",
        "",
        "# Original body",
        "must not change",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "MEMORY.md"),
      "# Memory Index\n\n## UI / front-end\n\n- [Nice Title](old-thing.md) — `abc` **DEPLOYED**, fine\n",
      "utf8",
    );
    return dir;
  }

  test("infers section from the old heading, date from modified, status and title from the old line", () => {
    const dir = legacyProject();
    const changes = migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "old-thing.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(changes.length, 1);
    assert.equal(data.metadata.section, "ui");
    assert.equal(data.metadata.date, "2026-04-05");
    assert.equal(data.metadata.status, "deployed");
    assert.equal(data.title, "Nice Title");
  });

  test("preserves provenance and the body exactly", () => {
    const dir = legacyProject();
    const before = readFileSync(join(dir, "old-thing.md"), "utf8");
    migrate(dir, readFacts(dir), SECTIONS);
    const after = readFileSync(join(dir, "old-thing.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.match(after, /originSessionId: sess-999/);
    assert.match(after, /node_type: memory/);
    assert.equal(bodyOf(after), bodyOf(before), "body must be byte-identical");
  });

  test("is idempotent — a second pass changes nothing", () => {
    const dir = legacyProject();
    migrate(dir, readFacts(dir), SECTIONS);
    const afterFirst = readFileSync(join(dir, "old-thing.md"), "utf8");
    const changes = migrate(dir, readFacts(dir), SECTIONS);
    const afterSecond = readFileSync(join(dir, "old-thing.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(changes, []);
    assert.equal(afterFirst, afterSecond);
  });

  test("never overwrites a field that is already set", () => {
    const dir = legacyProject();
    writeFileSync(
      join(dir, "old-thing.md"),
      '---\nname: old-thing\ntitle: Kept\ndescription: "d"\nmetadata:\n  section: current\n  date: 2020-01-01\n---\nbody\n',
      "utf8",
    );
    migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "old-thing.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(data.title, "Kept");
    assert.equal(data.metadata.section, "current");
    assert.equal(data.metadata.date, "2020-01-01");
  });

  test("corrects a name that was a human title, keeping the title", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "project_overview.md"),
      '---\nname: Example bot project overview\ndescription: "d"\nmetadata:\n  type: project\n---\nbody\n',
      "utf8",
    );
    migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "project_overview.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(data.name, "project_overview", "the filename wins");
    assert.equal(data.title, "Example bot project overview", "the old name is kept as the title");
  });

  test("drops a competing slug rather than displaying it as a title", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "project_example.md"),
      '---\nname: example-project-notes\ndescription: "d"\nmetadata:\n  type: project\n---\nbody\n',
      "utf8",
    );
    migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "project_example.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(data.name, "project_example");
    assert.equal(data.title, undefined, "a slug is not a title");
  });

  test("prefers the old index line's title over a name-derived one", () => {
    const dir = scratch();
    writeFileSync(join(dir, "thing.md"), '---\nname: Some Old Title\ndescription: "d"\nmetadata:\n  type: project\n---\nbody\n', "utf8");
    writeFileSync(join(dir, "MEMORY.md"), "## UI / front-end\n\n- [Better Title](thing.md) — d\n", "utf8");
    migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "thing.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(data.name, "thing");
    assert.equal(data.title, "Better Title");
  });

  test("does not invent a description it cannot know", () => {
    const dir = scratch();
    writeFileSync(join(dir, "broken.md"), '---\nname: ""\nmetadata:\n  type: gotcha\n---\nbody\n', "utf8");
    migrate(dir, readFacts(dir), SECTIONS);
    const { data } = parseFrontmatter(readFileSync(join(dir, "broken.md"), "utf8"));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(data.description, undefined);
    assert.equal(data.metadata.section, "current", "but it still places the file");
  });
});

// --- cold tier: search, archive, audit ------------------------------------------------------

describe("searchMemories", () => {
  function corpus() {
    const dir = scratch();
    writeFileSync(
      join(dir, "live.md"),
      '---\nname: live\ndescription: "d"\nmetadata:\n  section: current\n  date: 2026-08-01\n---\n\nKadaster owner-check costs EUR 3.70.\n',
      "utf8",
    );
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "archive", "retired.md"), "---\nname: retired\n---\n\nOld note about Kadaster tariffs.\n", "utf8");
    return dir;
  }

  test("reaches archived memories the index deliberately omits", () => {
    const dir = corpus();
    const { matches } = searchMemories(dir, "kadaster");
    rmSync(dir, { recursive: true, force: true });
    const files = matches.map((m) => m.file);
    assert.ok(files.includes("live.md"));
    assert.ok(files.includes("archive/retired.md"), "archiving must not mean losing");
  });

  test("is case-insensitive and reports line numbers", () => {
    const dir = corpus();
    const { matches } = searchMemories(dir, "KADASTER");
    rmSync(dir, { recursive: true, force: true });
    assert.ok(matches.length >= 2);
    assert.ok(matches.every((m) => m.line > 0));
  });

  test("says nothing rather than lying when there is no match", () => {
    const dir = corpus();
    const { matches, truncated } = searchMemories(dir, "nonexistent-term");
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(matches, []);
    assert.equal(truncated, false);
  });

  test("caps runaway results and says so", () => {
    const dir = scratch();
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, `f${i}.md`), `---\nname: f${i}\n---\n${"needle\n".repeat(10)}`, "utf8");
    }
    const { matches, truncated } = searchMemories(dir, "needle");
    rmSync(dir, { recursive: true, force: true });
    assert.equal(matches.length, 60);
    assert.equal(truncated, true);
  });

  test("countArchived counts only the archive directory", () => {
    const dir = corpus();
    assert.equal(countArchived(dir), 1);
    rmSync(dir, { recursive: true, force: true });

    const empty = scratch();
    assert.equal(countArchived(empty), 0, "a missing archive/ is zero, not a crash");
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("archivalCandidates", () => {
  test("months apart is computed on calendar months", () => {
    assert.equal(monthsBetween("2026-01-15", "2026-07-15"), 6);
    assert.equal(monthsBetween("2025-12-01", "2026-02-01"), 2);
    assert.equal(monthsBetween("nonsense", "2026-01-01"), 0);
  });

  test("suggests settled, old, non-primary memories only", () => {
    const dir = scratch();
    conformingFact(dir, "old-ui", { section: "ui", date: "2025-06-01", status: "deployed" });
    conformingFact(dir, "old-but-current", { section: "current", date: "2025-06-01", status: "deployed" });
    conformingFact(dir, "old-unsettled", { section: "ui", date: "2025-06-01", status: "plan-only" });
    conformingFact(dir, "recent-ui", { section: "ui", date: "2026-07-01", status: "deployed" });
    const found = archivalCandidates(readFacts(dir), SECTIONS, "2026-08-01").map((c) => c.file);
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(found, ["old-ui.md"]);
  });

  // The age floor could not fire when it was most needed: a corpus can reach the
  // size limit in five weeks, at which point nothing is six months old and this
  // returned nothing on the one corpus actually in trouble.
  test("relaxes the age floor once the index is over the warn threshold", () => {
    const dir = scratch();
    conformingFact(dir, "a-month-old", { section: "ui", date: "2026-07-01", status: "deployed" });
    const facts = readFacts(dir);

    const relaxed = archivalCandidates(facts, SECTIONS, "2026-08-04", 6, FAIL_BYTES).map((c) => c.file);
    const strict = archivalCandidates(facts, SECTIONS, "2026-08-04", 6, 0).map((c) => c.file);
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(relaxed, ["a-month-old.md"], "pressure should surface a month-old memory");
    assert.deepEqual(strict, [], "without pressure the six-month floor still applies");
  });

  // Ranking purely by size made the memory written that same afternoon the top
  // retirement candidate, because it happened to have the longest description.
  // Advice to retire today's work teaches the reader to ignore the list.
  test("never proposes retiring something written days ago, even under pressure", () => {
    const dir = scratch();
    conformingFact(dir, "written-today", { section: "ui", date: "2026-08-04", status: "deployed" });
    conformingFact(dir, "written-last-month", { section: "ui", date: "2026-07-01", status: "deployed" });
    const found = archivalCandidates(readFacts(dir), SECTIONS, "2026-08-04", 6, FAIL_BYTES).map((c) => c.file);
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(found, ["written-last-month.md"]);
  });

  test("under pressure, ranks by what each line costs the index — biggest first", () => {
    const dir = scratch();
    const meta = "metadata:\n  type: project\n  section: ui\n  date: 2026-07-01\n  status: deployed";
    fact(dir, "cheap", `name: cheap\ndescription: "Short."\n${meta}`);
    fact(dir, "costly", `name: costly\ndescription: "${"Long enough to cost real index bytes. ".repeat(4)}"\n${meta}`);
    const found = archivalCandidates(readFacts(dir), SECTIONS, "2026-08-04", 6, FAIL_BYTES);
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(found.map((c) => c.file), ["costly.md", "cheap.md"]);
    assert.ok(found[0].bytes > found[1].bytes, "bytes must be the real index-line cost");
  });
});

describe("perishableWithoutVerify", () => {
  function flagged(description, meta = {}) {
    const dir = scratch();
    const extra = Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    fact(dir, "x", `name: x\ndescription: "${description}"\nmetadata:\n  section: current\n  date: 2026-08-01${extra ? `\n${extra}` : ""}`);
    const result = perishableWithoutVerify(readFacts(dir));
    rmSync(dir, { recursive: true, force: true });
    return result.length === 1;
  }

  test("flags figures that move", () => {
    assert.ok(flagged("Kadaster costs €3.70 per lookup"));
    assert.ok(flagged("the pricing changed last quarter"));
    assert.ok(flagged("free tier is 1000 requests"));
    assert.ok(flagged("rate limit is 20/s"));
  });

  test("flags anything typed reference", () => {
    assert.ok(flagged("a link to the dashboard", { type: "reference" }));
  });

  test("stays quiet on ordinary prose, so the signal keeps meaning something", () => {
    assert.equal(flagged("The withdrawal-waiver box must stay for legal reasons"), false);
    assert.equal(flagged("the renderer silently falls back to another font"), false);
  });

  test("a money WORD without money is not perishable — these were real false positives", () => {
    // Both tripped the first version of the detector on the real corpus: a
    // filename and a feature name, neither of which can go stale.
    assert.equal(flagged("canonical euro parser is normalizeAmount in lib/signals/price.ts"), false);
    assert.equal(flagged("executed the plan steps 1-4 including SPA price harvest"), false);
  });

  test("says nothing once verify_by is set", () => {
    assert.equal(flagged("Kadaster costs €3.70", { verify_by: "2027-01-01" }), false);
  });
});

describe("auditPacket", () => {
  test("lists every memory, the mechanical findings, and the judgement task", () => {
    const dir = scratch();
    conformingFact(dir, "a", { verify_by: "2020-01-01" });
    conformingFact(dir, "b", { section: "ui" });
    const packet = auditPacket(dir, readFacts(dir), SECTIONS, "2026-08-01");
    rmSync(dir, { recursive: true, force: true });

    assert.match(packet, /2 memories/);
    assert.match(packet, /a\.md/);
    assert.match(packet, /b\.md/);
    assert.match(packet, /past verify_by: a\.md/);
    assert.match(packet, /CONTRADICTIONS/);
    assert.match(packet, /Do not edit or delete any memory without the owner agreeing/);
  });

  test("stays small enough to reason over in one pass", () => {
    const dir = scratch();
    for (let i = 0; i < 64; i++) conformingFact(dir, `m${String(i).padStart(2, "0")}`);
    const packet = auditPacket(dir, readFacts(dir), SECTIONS, "2026-08-01");
    rmSync(dir, { recursive: true, force: true });
    assert.ok(packet.length < 30_000, `packet was ${packet.length} chars`);
  });
});

// --- the CLI, end to end -----------------------------------------------------------------

// --- the native load limits ------------------------------------------------------
// Claude Code loads "the first 200 lines of MEMORY.md, or the first 25KB, whichever
// comes first". Guarding only bytes let a corpus of many short entries cross the
// line limit with everything past line 200 silently never loading again.

describe("loadedIndexSize", () => {
  test("measures only what Claude Code loads — frontmatter and block comments are stripped", () => {
    const raw = "---\nname: x\n---\n<!-- generated, do not edit -->\nreal content\n";
    const size = loadedIndexSize(raw);
    // Exactly the bytes that survive stripping: the comment leaves a blank line.
    assert.equal(size.bytes, Buffer.byteLength("\nreal content\n", "utf8"));
    assert.ok(size.bytes < Buffer.byteLength(raw, "utf8"), "stripped must be smaller than raw");
    // The banner comment on every generated MEMORY.md must cost nothing.
    const withBanner = loadedIndexSize(`<!-- ${"pad ".repeat(500)} -->\nreal content\n`);
    assert.equal(withBanner.bytes, Buffer.byteLength("\nreal content\n", "utf8"));
  });

  test("our fail thresholds sit below the documented native limits", () => {
    assert.ok(FAIL_BYTES < NATIVE_MAX_BYTES, "must fail before the byte cliff, not at it");
    assert.ok(FAIL_LINES < NATIVE_MAX_LINES, "must fail before the line cliff, not at it");
  });

  test("counts lines, so a corpus of short entries is caught under the byte cap", () => {
    const many = `${"- [x](x.md) — short\n".repeat(300)}`;
    const size = loadedIndexSize(many);
    assert.ok(size.bytes < NATIVE_MAX_BYTES, "this corpus is comfortably under the byte limit");
    assert.ok(size.lines > FAIL_LINES, "…and would still be truncated — bytes alone cannot see it");
  });
});

describe("projectRootFor", () => {
  test("a linked worktree resolves to the SAME project as the main worktree", () => {
    const base = scratch();
    const main = join(base, "repo");
    const linked = join(base, "wt");
    mkdirSync(main, { recursive: true });
    const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(main, ["init", "-q", "-b", "main"]);
    git(main, ["config", "user.email", "t@t"]);
    git(main, ["config", "user.name", "t"]);
    writeFileSync(join(main, "f.txt"), "x");
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "init"]);
    git(main, ["worktree", "add", "-q", linked, "-b", "side"]);

    const fromMain = projectRootFor(main);
    const fromLinked = projectRootFor(linked);
    rmSync(base, { recursive: true, force: true });

    // `--show-toplevel` would return the worktree here and fork the corpus in two.
    assert.equal(fromLinked, fromMain, "worktrees must share one corpus");
  });

  test("outside a git repository the project root is the directory itself", () => {
    const dir = scratch();
    const resolved = projectRootFor(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(resolved, dir);
  });
});

describe("CLI", () => {
  test("generates an index and a git repo from nothing", () => {
    const dir = scratch();
    conformingFact(dir, "first");
    const { code, out } = cli(["--dir", dir]);
    const written = existsSync(join(dir, "MEMORY.md"));
    const hasGit = existsSync(join(dir, ".git"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 0, out);
    assert.ok(written);
    assert.ok(hasGit, "first run must version the directory");
  });

  test("refuses to run from inside a memory directory, and creates nothing there", () => {
    // The failure this prevents is silent, not loud: the first such run CREATES
    // a corpus-of-the-corpus, so every run afterwards finds it, indexes zero
    // files and reports "OK". A real one existed on this machine from 2026-08-01.
    const dir = join(scratch(), "memory");
    mkdirSync(dir, { recursive: true });
    conformingFact(dir, "first");

    const { code, out } = cli(["--check"], dir);
    const leaked = existsSync(join(dir, "MEMORY.md"));

    // The escape hatch must still work from the same cwd. Generate rather than
    // --check: --check legitimately fails on a corpus that has no index yet.
    const explicit = cli(["--dir", dir], dir);
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 2, out);
    assert.match(out, /inside a memory directory/);
    assert.ok(!leaked, "must not write an index into the directory it refused");
    assert.equal(explicit.code, 0, explicit.out);
  });

  test("a second run rewrites nothing", () => {
    const dir = scratch();
    conformingFact(dir, "first");
    cli(["--dir", dir]);
    const { code, out } = cli(["--dir", dir]);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 0);
    assert.match(out, /already current/);
  });

  test("refuses to write when a fact-file is invalid, and leaves the old index alone", () => {
    const dir = scratch();
    conformingFact(dir, "good");
    cli(["--dir", dir]);
    const before = readFileSync(join(dir, "MEMORY.md"), "utf8");

    fact(dir, "bad", "name: bad\nmetadata:\n  section: current\n  date: 2026-08-01");
    const { code, out } = cli(["--dir", dir]);
    const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 1);
    assert.match(out, /bad\.md/);
    assert.equal(after, before, "a failed run must not touch the index");
  });

  test("--check writes nothing at all, even in a project needing migration", () => {
    const dir = scratch();
    writeFileSync(join(dir, "legacy.md"), '---\nname: legacy\ndescription: "d"\nmetadata:\n  type: project\n---\nbody\n', "utf8");
    const before = readFileSync(join(dir, "legacy.md"), "utf8");
    const { code } = cli(["--dir", dir, "--check"]);
    const after = readFileSync(join(dir, "legacy.md"), "utf8");
    const madeIndex = existsSync(join(dir, "MEMORY.md"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 1, "an un-migrated project is not valid yet");
    assert.equal(after, before, "--check must never write");
    assert.equal(madeIndex, false);
  });

  test("--no-migrate leaves legacy files untouched and fails validation", () => {
    const dir = scratch();
    writeFileSync(join(dir, "legacy.md"), '---\nname: legacy\ndescription: "d"\nmetadata:\n  type: project\n---\nbody\n', "utf8");
    const before = readFileSync(join(dir, "legacy.md"), "utf8");
    const { code } = cli(["--dir", dir, "--no-migrate"]);
    const after = readFileSync(join(dir, "legacy.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.equal(after, before);
  });

  test("migrates a legacy project on first run and then validates clean", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "legacy.md"),
      '---\nname: legacy\ndescription: "d"\nmetadata:\n  type: project\n  originSessionId: keep-me\n---\nbody\n',
      "utf8",
    );
    const first = cli(["--dir", dir]);
    const second = cli(["--dir", dir, "--check"]);
    const content = readFileSync(join(dir, "legacy.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /migrated:\s+1 file/);
    assert.equal(second.code, 0, second.out);
    assert.match(content, /originSessionId: keep-me/);
  });

  test("hard-fails on an oversized index and names the worst offenders", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "sections.json"),
      JSON.stringify({ sections: [{ id: "current", title: "C", maxChars: 400 }] }),
      "utf8",
    );
    for (let i = 0; i < 90; i++) {
      const name = `pad-${String(i).padStart(3, "0")}`;
      fact(dir, name, `name: ${name}\ndescription: "${"x".repeat(300)}"\nmetadata:\n  section: current\n  date: 2026-08-01`);
    }
    const { code, out } = cli(["--dir", dir]);
    const madeIndex = existsSync(join(dir, "MEMORY.md"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 1);
    assert.match(out, /over the 22 KB limit/);
    assert.match(out, /Spent per section/);
    assert.equal(madeIndex, false, "an oversized index must not be written");
  });

  test("ignores an archive/ subdirectory entirely", () => {
    const dir = scratch();
    conformingFact(dir, "live");
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "archive", "retired.md"), "---\nname: nonsense\n---\nbroken on purpose\n", "utf8");
    const { code } = cli(["--dir", dir]);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.equal(code, 0, "a broken file in archive/ must not block anything");
    assert.doesNotMatch(index, /retired\.md/);
  });

  test("rejects unknown arguments and a missing directory with exit 2", () => {
    assert.equal(cli(["--nope"]).code, 2);
    assert.equal(cli(["--dir", "/definitely/not/here"]).code, 2);
    assert.equal(cli(["--dir", "/tmp", "--search"]).code, 2, "--search needs a query");
  });

  test("--search and --audit write nothing, not even in a project needing migration", () => {
    const dir = scratch();
    writeFileSync(join(dir, "legacy.md"), '---\nname: legacy\ndescription: "mentions €9 pricing"\nmetadata:\n  type: project\n---\nbody\n', "utf8");
    const before = readFileSync(join(dir, "legacy.md"), "utf8");

    const search = cli(["--dir", dir, "--search", "pricing"]);
    const audit = cli(["--dir", dir, "--audit"]);
    const after = readFileSync(join(dir, "legacy.md"), "utf8");
    const madeIndex = existsSync(join(dir, "MEMORY.md"));
    rmSync(dir, { recursive: true, force: true });

    assert.equal(search.code, 0);
    assert.match(search.out, /legacy\.md:/);
    assert.equal(audit.code, 0);
    assert.match(audit.out, /Memory audit packet/);
    assert.equal(after, before, "read-only modes must not migrate");
    assert.equal(madeIndex, false, "read-only modes must not write an index");
  });

  test("the generated index points at the archive and how to search it", () => {
    const dir = scratch();
    conformingFact(dir, "live");
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "archive", "retired.md"), "---\nname: retired\n---\nbody\n", "utf8");
    cli(["--dir", dir]);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    rmSync(dir, { recursive: true, force: true });

    assert.match(index, /1 archived \(searchable, not listed\)/);
    assert.match(index, /--search <query>/, "a session must be able to discover the cold tier");
  });

  test("nudges about perishable facts once, as a single line", () => {
    const dir = scratch();
    for (let i = 0; i < 3; i++) {
      fact(dir, `p${i}`, `name: p${i}\ndescription: "costs €${i}.50 per month"\nmetadata:\n  section: current\n  date: 2026-08-01`);
    }
    const { out } = cli(["--dir", dir]);
    rmSync(dir, { recursive: true, force: true });

    const notes = out.split("\n").filter((l) => l.startsWith("note:") && l.includes("perishable"));
    assert.equal(notes.length, 1, "one line, never one per file — a repeated nudge becomes wallpaper");
    assert.match(notes[0], /3 memories look perishable/);
  });

  test("leaves no temporary files behind", () => {
    const dir = scratch();
    conformingFact(dir, "a");
    cli(["--dir", dir]);
    const strays = readFacts(dir).filter((f) => f.file.includes(".tmp-"));
    const wrote = existsSync(join(dir, "MEMORY.md"));
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(strays, []);
    assert.ok(wrote);
  });
});
