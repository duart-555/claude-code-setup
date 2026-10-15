import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findBareDashPaths, denialReason } from "../hooks/dash-path-guard.mjs";

// The three cases below are VERBATIM from 2026-08-04. Each one produced a wrong
// answer or a confusing error while the trap was written down in memory and being
// actively ignored. They are the reason this guard exists, so they are the tests.

describe("dash-path-guard — the commands that actually went wrong", () => {
  test("grep over a project dir: produced a wrong conclusion, not an error", () => {
    const cmd = `grep -rho "no memory yet" -Users-example-Documents-project/*.jsonl`;
    assert.deepEqual(findBareDashPaths(cmd), ["-Users-example-Documents-project/*.jsonl"]);
  });

  test("node with a slug as a positional arg: 'node: bad option'", () => {
    const cmd = `node --input-type=module -e 'x' "-private-tmp-claude-501-scratchpad-fake"`;
    assert.deepEqual(findBareDashPaths(cmd), ["-private-tmp-claude-501-scratchpad-fake"]);
  });

  test("quoting does NOT make it safe — the shell strips quotes, the program still sees '-'", () => {
    assert.equal(findBareDashPaths(`ls "-Users-x-Documents-project"`).length, 1);
    assert.equal(findBareDashPaths(`ls '-Users-x-Documents-project'`).length, 1);
  });
});

describe("dash-path-guard — must not fire on correct commands", () => {
  const safe = [
    // absolute path: the leading slash disarms it
    `ls /Users/example/.claude/projects/-Users-x-project/memory`,
    `node scripts/memory-index.mjs --dir "$HOME/.claude/projects/-Users-x/memory"`,
    // ./ prefix — the documented fix
    `grep -r "x" ./-Users-example-Documents-project/`,
    // explicit pattern value
    `grep -F -e "-Users-example-Documents-project"`,
    // after the -- separator, everything is positional by contract
    `rm -- -Users-x-project`,
    // flag values are already unambiguous
    `node memory-index.mjs --dir -Users-x-project`,
    // ordinary commands must never be touched
    `npm test`,
    `git -C ~/.claude/projects/-Users-x/memory status --porcelain`,
    `ls -la`,
    `tar -cf - -C /tmp .`,
  ];
  for (const cmd of safe) {
    test(`allows: ${cmd.slice(0, 58)}`, () => {
      assert.deepEqual(findBareDashPaths(cmd), [], `should not have flagged: ${cmd}`);
    });
  }
});

describe("dash-path-guard — heredoc bodies are data, not arguments", () => {
  // The guard's FIRST real firing was a false positive: a `git commit -F -`
  // whose message prose described the very trap it guards against. Heredoc
  // contents are a payload, so a path mentioned there is not an argument.
  test("a commit message that merely mentions a slug is allowed", () => {
    const cmd = [
      `git commit -q -F - <<'MSG'`,
      `fix: block Bash calls passing a -Users-you-Documents-myrepo slug bare`,
      ``,
      `Those start with a hyphen so grep reads them as flags.`,
      `MSG`,
    ].join("\n");
    assert.deepEqual(findBareDashPaths(cmd), []);
  });

  test("but a real argument on the SAME command line is still caught", () => {
    const cmd = [`grep -r x -Users-you-Documents-myrepo/ <<'EOF'`, `-Users-mentioned-in-body`, `EOF`].join("\n");
    assert.deepEqual(findBareDashPaths(cmd), ["-Users-you-Documents-myrepo/"]);
  });

  test("unterminated heredoc does not swallow the rest of the command", () => {
    const cmd = `cat <<'EOF' -Users-you-real-argument`;
    assert.deepEqual(findBareDashPaths(cmd), ["-Users-you-real-argument"]);
  });
});

describe("dash-path-guard — robustness", () => {
  test("empty, undefined and non-string commands are allowed, never thrown on", () => {
    for (const input of ["", undefined, null, 42, {}]) {
      assert.deepEqual(findBareDashPaths(input), []);
    }
  });

  test("finds every offender, not just the first", () => {
    const cmd = `cp -Users-a-b -Users-c-d`;
    assert.equal(findBareDashPaths(cmd).length, 2);
  });

  test("the denial names the offender and the way out", () => {
    const reason = denialReason(["-Users-x-project"]);
    assert.match(reason, /-Users-x-project/);
    assert.match(reason, /\.\/-Users/, "must show the ./ fix");
    assert.match(reason, /SILENT/, "must say why this is denied rather than warned");
  });
});
