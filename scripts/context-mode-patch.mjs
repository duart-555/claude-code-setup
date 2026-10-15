#!/usr/bin/env node
/**
 * Re-applies two local fixes to the context-mode plugin after it updates.
 *
 * WHY THIS EXISTS. context-mode injects a `<session_guide>` at every SessionStart
 * and after every compaction. Measured 2026-08-04 on one session: 66 KB across
 * four restarts, of which 13.5 KB per injection was a section titled "Unresolved
 * Errors" holding 88 entries — every one of which had a ZERO exit code. They were
 * grep output and passing test runs, captured because the classifier matched the
 * words `failed` / `FAIL` / `Error:` against a command's OUTPUT and never looked
 * at its exit status. A test named "surfaces a mail-relay failure as 502" passing
 * cleanly was filed as an unresolved error and re-sent forever.
 *
 * The fixes live in the plugin's cache directory, which any update overwrites.
 * This script puts them back. It is idempotent and it fails loudly rather than
 * quietly doing nothing, because a patch that silently stops applying is worse
 * than no patch — you would go on believing the guide was small.
 *
 *   node ~/.claude/scripts/context-mode-patch.mjs          # apply (idempotent)
 *   node ~/.claude/scripts/context-mode-patch.mjs --check  # report only, exit 1 if unpatched
 *
 * Worth upstreaming: https://github.com/mksglu/context-mode
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), ".claude", "plugins", "cache", "context-mode", "context-mode");

/** Newest installed version directory — the one Claude Code actually loads. */
function pluginRoot() {
  if (!existsSync(CACHE)) throw new Error(`context-mode is not installed at ${CACHE}`);
  const versions = readdirSync(CACHE)
    .map((name) => ({ name, path: join(CACHE, name) }))
    .filter((v) => statSync(v.path).isDirectory())
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  if (!versions.length) throw new Error(`No version directories under ${CACHE}`);
  return versions[0];
}

/**
 * Each patch is a find/replace with an explicit expectation: the old text occurs
 * exactly once. A count that is neither 1 nor 0 means upstream changed shape —
 * refuse rather than guess.
 */
const PATCHES = [
  {
    file: "hooks/session-directive.mjs",
    why: "cap the Unresolved Errors list (it had no count cap, unlike Data References)",
    find: "    block += `\\n## Unresolved Errors`;\n    for (const ev of grouped.error) {",
    replace:
      "    const shownErrors = grouped.error.slice(-8);\n" +
      "    const hiddenErrors = grouped.error.length - shownErrors.length;\n" +
      "    block += `\\n## Unresolved Errors`;\n" +
      "    for (const ev of shownErrors) {",
    done: "const shownErrors = grouped.error.slice(",
  },
  {
    file: "hooks/session-directive.mjs",
    why: "name what was dropped instead of showing a silently partial list",
    find: "      block += `\\n- ${text}`;\n    }\n    block += `\\n`;\n  }\n\n  // 6. Git state",
    replace:
      "      block += `\\n- ${text}`;\n    }\n" +
      "    if (hiddenErrors > 0) block += `\\n- (+${hiddenErrors} older — query ${dataSearchHint})`;\n" +
      "    block += `\\n`;\n  }\n\n  // 6. Git state",
    done: "hiddenErrors > 0",
  },
  {
    file: "hooks/session-extract.bundle.mjs",
    why: "classify a Bash failure by exit status, not by words in its output",
    find: String.raw`/exit code [1-9]|error:|Error:|FAIL|failed/i`,
    replace: String.raw`/exit code [1-9]/`,
    done: null, // absence of `find` is itself the done-marker
  },
  {
    file: "src/session/extract.ts",
    why: "same fix in the TypeScript source, so a local rebuild does not undo it",
    find: String.raw`/exit code [1-9]|error:|Error:|FAIL|failed/i`,
    replace: String.raw`/exit code [1-9]/`,
    done: null,
  },
];

function main() {
  const checkOnly = process.argv.includes("--check");
  // --quiet says NOTHING when every patch is already present. That is what makes
  // it safe to run at every session start: a hook that prints on a healthy run
  // becomes wallpaper, and then nobody reads it on the run that matters.
  const quiet = process.argv.includes("--quiet");
  const say = quiet ? () => {} : console.log;

  const root = pluginRoot();
  say(`context-mode ${root.name}`);

  let applied = 0;
  let already = 0;
  let broken = 0;

  for (const patch of PATCHES) {
    const path = join(root.path, patch.file);
    if (!existsSync(path)) {
      console.warn(`  SKIP    ${patch.file} — not present in this version`);
      broken++;
      continue;
    }
    const text = readFileSync(path, "utf8");
    const hits = text.split(patch.find).length - 1;

    const isDone = patch.done ? text.includes(patch.done) : hits === 0;
    if (isDone && hits === 0) {
      say(`  ok      ${patch.file} — ${patch.why}`);
      already++;
      continue;
    }
    if (hits !== 1) {
      console.error(
        `  CHANGED ${patch.file} — expected 1 occurrence to patch, found ${hits}. ` +
          `Upstream code moved; re-read it before trusting the guide size.`,
      );
      broken++;
      continue;
    }
    if (checkOnly) {
      console.log(`  NEEDED  ${patch.file} — ${patch.why}`);
      applied++;
      continue;
    }
    writeFileSync(path, text.split(patch.find).join(patch.replace));
    console.log(`  PATCHED ${patch.file} — ${patch.why}`);
    applied++;
  }

  if (broken) {
    console.error(`\n${broken} patch(es) could not be applied — see above.`);
    process.exit(1);
  }
  if (checkOnly && applied) {
    console.error(`\n${applied} patch(es) missing. Run without --check to apply.`);
    process.exit(1);
  }
  // The one line worth printing on an otherwise-quiet run: a patch was silently
  // erased by a plugin update and has just been put back.
  if (quiet && applied > 0) {
    console.log(
      `context-mode: re-applied ${applied} local patch(es) after a plugin update ` +
        `(the session_guide would otherwise inject ~13 KB of misclassified "errors").`,
    );
    return;
  }
  say(
    checkOnly
      ? `\nAll ${already} patches present.`
      : `\n${applied} applied, ${already} already present.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`context-mode-patch FAILED: ${error.message}`);
  process.exit(1);
}
