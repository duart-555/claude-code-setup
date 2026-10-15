#!/usr/bin/env node
/**
 * Blocks Bash commands that pass a leading-hyphen path as a bare argument.
 *
 * WHY THIS EXISTS. Claude Code names project directories by replacing every
 * non-alphanumeric character with a hyphen, so `/Users/x/Documents/project`
 * becomes `-Users-x-Documents-project`. Every one of those names starts with a
 * hyphen, and `grep`, `node`, `ls`, `find` and friends read a leading hyphen as
 * the start of a flag — not a path.
 *
 * The failure is SILENT-WRONG, not loud. Real examples from this machine:
 *
 *   grep -rho "no memory yet" -Users-example-Documents-project/*.jsonl
 *     → "grep: invalid option -- t"  … or worse, 0 results and a wrong conclusion
 *   node -e '…' "$SLUG"
 *     → "node: bad option: -private-tmp-…"
 *
 * The first of those produced a confident, wrong answer about whether claude-mem
 * had ever recalled a memory — a conclusion that reached a written report before
 * it was caught.
 *
 * The trap was written into memory on 2026-08-04 and then walked into twice more
 * the same day. That is the point: **memory gives recall, not enforcement.** A
 * note you have to remember to read cannot stop a mistake. A hook can.
 *
 * Deny rather than warn, because a false negative (a wrong answer you believe)
 * costs far more than a false positive (retype one argument). The pattern is
 * deliberately narrow — a bare token beginning `-Users-`, `-home-`, `-private-`,
 * `-Volumes-`, `-tmp-` or `-var-` is a filesystem slug in every real case and a
 * flag in none.
 */

import { readFileSync } from "node:fs";

// Slug prefixes that can only ever be a path. No real flag is named `-Users-…`;
// keeping the list closed is what makes denial safe rather than annoying.
const SLUG_START = /^-(?:Users|home|private|Volumes|tmp|var)-/;

// Flags whose NEXT token is a value, so a hyphen there is already unambiguous.
// `grep -e -Users-…` and `--dir -Users-…` are both correct as written.
const TAKES_VALUE = new Set([
  "-e", "-f", "--file", "--dir", "--directory", "--path", "--archive",
  "--out", "--output", "--source", "--include", "--exclude", "-C", "-o",
]);

/** Strip one layer of surrounding quotes — the program still sees the hyphen. */
function unquote(token) {
  const quoted =
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"));
  return quoted && token.length > 1 ? token.slice(1, -1) : token;
}

/**
 * Every bare leading-hyphen path in a command, in order. Quoting does NOT make
 * one safe: the shell strips the quotes and the program still receives a token
 * beginning with `-`, which is exactly how `node -e '…' "$SLUG"` failed.
 */
/**
 * Remove heredoc bodies before tokenizing. Their contents are DATA — a commit
 * message, a file being written — not arguments, and prose there routinely
 * mentions paths. Caught on this guard's first real firing: it blocked a
 * `git commit -F -` whose message merely *described* the trap it guards against.
 */
function stripHeredocs(command) {
  // <<'EOF' … EOF, <<EOF … EOF, <<-EOF … EOF
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    "<<HEREDOC_BODY_STRIPPED",
  );
}

export function findBareDashPaths(command) {
  const tokens = stripHeredocs(String(command || "")).split(/\s+/).filter(Boolean);
  const found = [];
  let afterDoubleDash = false;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash) continue; // past `--` everything is positional by contract

    const token = unquote(raw);
    if (!SLUG_START.test(token)) continue;

    const previous = i > 0 ? unquote(tokens[i - 1]) : "";
    if (TAKES_VALUE.has(previous)) continue; // it is a flag's value, not a stray path

    found.push(token);
  }
  return found;
}

export function denialReason(paths) {
  const list = paths.map((p) => `  ${p}`).join("\n");
  return (
    `This command passes ${paths.length === 1 ? "a path" : "paths"} beginning with "-" as a bare ` +
    `argument:\n${list}\n\n` +
    `Claude Code project slugs always start with a hyphen, and grep/node/ls/find read that as a ` +
    `flag. The failure is usually SILENT — wrong results rather than an error — so this is denied ` +
    `rather than warned about.\n\nUse one of:\n` +
    `  ./-Users-…                          prefix with ./ so it is unambiguously a path\n` +
    `  "$HOME/.claude/projects/-Users-…"   an absolute path; the leading / makes it safe\n` +
    `  grep -F -e "-Users-…"               pass it as an explicit pattern value\n` +
    `  cmd -- -Users-…                     end flag parsing first\n` +
    `  VAR="-Users-…" node …               hand it over through the environment`
  );
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return; // unparseable stdin is not this hook's problem — allow
  }
  if (payload.tool_name !== "Bash") return;

  const paths = findBareDashPaths(payload.tool_input?.command);
  if (paths.length === 0) return;

  // deny + reason: the call is blocked and the reason returns to Claude as a tool
  // error, so it can fix the quoting and retry rather than the turn ending.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denialReason(paths),
      },
    }),
  );
}

const isCli = process.argv[1] && process.argv[1].endsWith("dash-path-guard.mjs");
if (isCli) {
  // Never break a session over this. Any unexpected failure means allow.
  try {
    main();
  } catch {
    /* allow */
  }
  process.exit(0);
}
