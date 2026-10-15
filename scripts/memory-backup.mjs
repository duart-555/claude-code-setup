#!/usr/bin/env node
/**
 * Encrypted offsite backup of EVERY project's memory corpus.
 *
 * WHY THIS EXISTS. Memory is the only artifact here that is not derivable from
 * anything else: code is on GitHub, the database is in R2, `git log` answers what
 * shipped when — but the decisions, the traps that cost real time, and the status
 * nobody can infer live only in these files. They were on exactly one disk.
 *
 * WHY ENCRYPTED, AND NOT A GIT REMOTE. `MEMORY_SYSTEM_PLAN.md` §A4 settled "do not
 * add a remote — these notes are local working memory, and some contain commercial
 * detail that has no business on a hosting service." That reasoning is right and is
 * preserved here rather than overridden: R2 only ever receives an `age` ciphertext,
 * so the host stores bytes it cannot read. What changed is the owner's instruction
 * to make the corpus survive a dead disk, which a local-only repo cannot do.
 *
 * WHAT IS CAPTURED. `git bundle --all` per corpus — full history, not a snapshot,
 * so a bad edit is recoverable and not only a lost disk. Uncommitted files are NOT
 * in a bundle; this reports them loudly rather than quietly backing up less than it
 * appears to.
 *
 *   node ~/.claude/scripts/memory-backup.mjs
 *   node ~/.claude/scripts/memory-backup.mjs --out ./tmp --no-upload   # local only
 *
 * Zero dependencies: git, tar and age are shelled out to; R2 is signed by
 * ./memory-s3.mjs. Requires AGE_PUBLIC_KEY and R2_* in ~/.claude/.env.memory-backup.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const ENV_FILE = join(CLAUDE_DIR, ".env.memory-backup");
const OBJECT_PREFIX = "memory/";
const INDEX_FILE = "MEMORY.md";

// `os.hostname()` is stable on a VPS but NOT on a laptop: on macOS it tracks
// the network-assigned DHCP/Bonjour name, which changes per WiFi network
// (confirmed directly: the same Mac reported "wlan-113016.nbw.tue.nl" on one
// network). A hostname-scoped backup key built from that would scatter across
// a different object every time the laptop changes networks, and a restore
// run from yet another network would never find its own backup again — the
// exact bug the hostname-scoping fix was meant to prevent, just one layer up.
// `LocalHostName` (not `ComputerName`) deliberately: ComputerName is the
// human display name ("Alice's MacBook Air" — a space and a unicode
// apostrophe, confirmed by actually calling it, not assumed) which is unsafe
// in an R2 object key / filename. LocalHostName is the same stable identity
// already hyphen-sanitized for exactly this kind of use ("Alices-MacBook-Air").
// Linux has no equivalent distinction, so `scutil` simply isn't there and this
// falls through to the same `hostname()` as before.
export function stableHostname() {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "LocalHostName"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (name) return name;
    } catch {
      // scutil missing or failed — fall through
    }
  }
  return hostname();
}

/**
 * A deliberately small `.env` reader — no dotenv dependency. Handles `KEY=value`,
 * `export KEY=value`, quotes and `#` comments; anything fancier belongs in a real
 * secret manager, not here.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  // Existing process env wins, so a one-off override on the command line works.
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(ENV_FILE, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** Every memory directory that holds at least one fact-file. */
export function findCorpora(projectsDir = PROJECTS_DIR) {
  if (!existsSync(projectsDir)) return [];
  const found = [];
  for (const entry of readdirSync(projectsDir)) {
    const dir = join(projectsDir, entry, "memory");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const facts = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== INDEX_FILE);
    if (facts.length === 0) continue;
    const indexPath = join(dir, INDEX_FILE);
    found.push({
      project: entry,
      dir,
      factCount: facts.length,
      indexBytes: existsSync(indexPath) ? statSync(indexPath).size : 0,
    });
  }
  return found.sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * The machinery that reads the memories is worth little without them, but the
 * reverse also holds: restoring 100 memories onto a machine with no generator, no
 * hook and no written contract means reconstructing all of it from the files
 * themselves. These are small, so they ride along.
 *
 * An EXPLICIT ALLOWLIST, never a glob. `.env.memory-backup` sits beside these and
 * holds the R2 credentials; a pattern that swept it in would put the keys inside
 * the archive they protect, turning one leaked file into two losses. The example
 * template has the same shape with no values.
 */
const HARNESS_FILES = [
  "scripts/memory-index.mjs",
  "scripts/memory-index.test.mjs",
  "scripts/memory-backup.mjs",
  "scripts/memory-backup.test.mjs",
  "scripts/memory-restore-verify.mjs",
  "scripts/memory-s3.mjs",
  // Added 2026-08-11. Both are unattended machinery: one archives corpora on a
  // weekly LaunchAgent, the other injects memories when a command fails. Neither
  // lives in a git repo of its own (~/.claude is not one), so if they are not in
  // this list they exist in exactly one place on one disk — which is the failure
  // this whole backup exists to prevent.
  "scripts/memory-autoarchive.mjs",
  "hooks/memory-recall-on-failure.mjs",
  "hooks/memory-check.mjs",
  "CLAUDE.md",
  "MEMORY_SYSTEM_PLAN.md",
  ".env.memory-backup.example",
];

function stageHarness(stageDir) {
  const included = [];
  for (const relative of HARNESS_FILES) {
    const source = join(CLAUDE_DIR, relative);
    if (!existsSync(source)) continue;
    const target = join(stageDir, "harness", relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    included.push(relative);
  }
  return included;
}

function requireTool(name, args = ["--version"]) {
  try {
    execFileSync(name, args, { stdio: "pipe" });
  } catch {
    throw new Error(`\`${name}\` is not installed or not on PATH — cannot continue.`);
  }
}

function bundleCorpus(corpus, stageDir) {
  if (!existsSync(join(corpus.dir, ".git"))) {
    return { ...corpus, skipped: "no git repository — run the generator once to create it" };
  }
  const bundle = join(stageDir, `${corpus.project}.bundle`);
  try {
    // Uncommitted work is invisible to `git bundle`. Saying so is the difference
    // between a backup and the belief in one.
    const dirty = git(corpus.dir, ["status", "--porcelain"]).length > 0;
    const head = git(corpus.dir, ["rev-parse", "HEAD"]);
    git(corpus.dir, ["bundle", "create", bundle, "--all"]);
    return { ...corpus, head, dirty, bundle: `${corpus.project}.bundle` };
  } catch (error) {
    return { ...corpus, skipped: String(error.message).split("\n")[0] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node memory-backup.mjs [--out <dir>] [--no-upload]");
    return;
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
  const upload = !args.includes("--no-upload");

  loadEnv();

  const recipient = process.env.AGE_PUBLIC_KEY;
  if (!recipient) {
    throw new Error(
      "AGE_PUBLIC_KEY is not set — refusing to write an unencrypted backup of memories " +
        `that carry commercial detail. Put it in ${ENV_FILE} (chmod 600).`,
    );
  }
  requireTool("age");
  requireTool("tar");
  requireTool("git");

  const corpora = findCorpora();
  if (corpora.length === 0) throw new Error("No memory corpora found — nothing to back up.");

  const stage = mkdtempSync(join(tmpdir(), "memory-backup-"));
  const date = new Date().toISOString().slice(0, 10);
  // Hostname-scoped: without it, every machine backing up on the same day
  // writes the same R2 key and silently overwrites the others' backup —
  // found via the restore drill, each "Uploaded and verified" was real but
  // only the last machine to run that day survived in the bucket.
  const archiveName = `${date}-${stableHostname()}.tar.age`;
  const destination = outDir ?? stage;
  if (outDir) mkdirSync(outDir, { recursive: true });
  const archivePath = join(destination, archiveName);

  try {
    const results = corpora.map((c) => bundleCorpus(c, stage));
    const bundled = results.filter((r) => r.bundle);
    const skipped = results.filter((r) => r.skipped);
    if (bundled.length === 0) throw new Error("Every corpus failed to bundle — nothing to upload.");

    const harness = stageHarness(stage);
    const manifest = {
      takenAt: new Date().toISOString(),
      corpora: bundled.map(({ project, factCount, indexBytes, head, dirty, bundle }) => ({
        project,
        factCount,
        indexBytes,
        head,
        dirty,
        bundle,
      })),
      skipped: skipped.map(({ project, skipped: why }) => ({ project, reason: why })),
      harness,
    };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const members = ["manifest.json", ...bundled.map((b) => b.bundle), ...(harness.length ? ["harness"] : [])];
    // tar to stdout, straight into age. The plaintext tar never touches disk.
    // "--" stops tar from reading project-derived member names starting
    // with "-" (e.g. "-home-ubuntu-my-project.bundle") as its own flags —
    // GNU tar (Linux) errors on that ("invalid option"); bsdtar (macOS)
    // happens to tolerate it, which is why this only surfaced on the VPS.
    const tar = execFileSync("tar", ["-cf", "-", "-C", stage, "--", ...members], {
      maxBuffer: 512 * 1024 * 1024,
    });
    execFileSync("age", ["-r", recipient, "-o", archivePath], { input: tar });

    const bytes = statSync(archivePath).size;
    const facts = bundled.reduce((sum, b) => sum + b.factCount, 0);
    console.log(
      `Encrypted ${bundled.length} corpora (${facts} memories) + ${harness.length} harness files ` +
        `→ ${archiveName}, ${(bytes / 1024).toFixed(0)} KiB`,
    );

    const dirtyOnes = bundled.filter((b) => b.dirty);
    if (dirtyOnes.length) {
      console.warn(
        `WARNING: ${dirtyOnes.length} corpus/corpora have UNCOMMITTED changes, which are NOT in this ` +
          `backup: ${dirtyOnes.map((d) => d.project).join(", ")}. Commit them and re-run.`,
      );
    }
    for (const { project, reason } of manifest.skipped) {
      console.warn(`WARNING: skipped ${project} — ${reason}`);
    }

    if (!upload) {
      console.log(`Wrote ${archivePath} (upload skipped)`);
      return;
    }

    const { makeR2, putObject, headObject } = await import("./memory-s3.mjs");
    const r2 = makeR2();
    const key = `${OBJECT_PREFIX}${archiveName}`;
    await putObject(r2, key, readFileSync(archivePath));

    // Read it back. An upload that was never verified is a hypothesis.
    const head = await headObject(r2, key);
    if (!head) throw new Error(`Uploaded ${key} but it is not there on read-back.`);
    if (head.size !== bytes) {
      throw new Error(`Uploaded ${key} at ${bytes} bytes but read back ${head.size}.`);
    }
    console.log(`Uploaded and verified ${key} (${head.size} bytes) in ${r2.bucket}`);
    console.log(`Restore drill: node ${join(CLAUDE_DIR, "scripts/memory-restore-verify.mjs")}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const isCli = process.argv[1] && process.argv[1].endsWith("memory-backup.mjs");
if (isCli) {
  main().catch((error) => {
    console.error(`\nBACKUP FAILED: ${error.message}`);
    process.exit(1);
  });
}
