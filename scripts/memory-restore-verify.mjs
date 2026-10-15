#!/usr/bin/env node
/**
 * The restore drill. A backup that has never been restored is not a backup — it is
 * a belief about a file. This decrypts the newest archive, reconstructs every
 * corpus from its bundle, and diffs the result against what is on disk now.
 *
 *   node ~/.claude/scripts/memory-restore-verify.mjs                 # newest in R2
 *   node ~/.claude/scripts/memory-restore-verify.mjs --archive x.age # a local file
 *   node ~/.claude/scripts/memory-restore-verify.mjs --keep <dir>    # keep restored
 *
 * EXITS NON-ZERO on any mismatch. That is the whole point: a verifier that cannot
 * fail proves nothing, so the drill includes deliberately breaking a restored file
 * and watching this notice.
 *
 * A corpus that has moved on since the backup reports as DRIFTED, not as failure —
 * that is expected and is counted separately from CORRUPT, which is not.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, stableHostname } from "./memory-backup.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const ENV_FILE = join(CLAUDE_DIR, ".env.memory-backup");
const OBJECT_PREFIX = "memory/";
const INDEX_FILE = "MEMORY.md";

function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(ENV_FILE, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * age needs the identity in a file. When it is supplied as material we write it to
 * a 0600 temp file and delete it in `finally` — the key never lands in a durable
 * path and never reaches a log.
 */
/**
 * Conventional key locations, checked when nothing is configured. This exists
 * because the obvious instruction — "copy your key, then run
 * AGE_PRIVATE_KEY=$(pbpaste) …" — is self-defeating: copying the COMMAND
 * overwrites the key on the clipboard, and age then fails with the unhelpful
 * "unknown identity type". A default path makes the drill a command short enough
 * to type, so the clipboard is never in the loop.
 */
const DEFAULT_IDENTITY_PATHS = [
  join(homedir(), ".age", "memory.txt"),
  join(homedir(), ".age", "key.txt"),
  join(homedir(), ".config", "age", "keys.txt"),
];

function withIdentityFile(fn) {
  const path = process.env.AGE_IDENTITY_FILE;
  if (path) {
    if (!existsSync(path)) throw new Error(`AGE_IDENTITY_FILE points at ${path}, which does not exist.`);
    return fn(path);
  }

  const material = process.env.AGE_PRIVATE_KEY;
  if (!material) {
    const found = DEFAULT_IDENTITY_PATHS.find((candidate) => existsSync(candidate));
    if (found) return fn(found);
    throw new Error(
      "No age identity. Either save the key to " +
        `${DEFAULT_IDENTITY_PATHS[0]} (chmod 600) and re-run with no arguments, ` +
        "or pass AGE_IDENTITY_FILE=<path>. If the key exists nowhere on this machine and " +
        "nowhere off it, the backup cannot be read and is not a backup.",
    );
  }

  // A key pasted through a shell can arrive as something else entirely; age reports
  // that as "unknown identity type", which names the symptom and not the cause.
  // Only the length and the first four characters are quoted — an age secret key
  // begins with the constant "AGE-", so this cannot disclose key material.
  if (!/^\s*(AGE-SECRET-KEY-1|#|-----BEGIN)/m.test(material)) {
    throw new Error(
      `AGE_PRIVATE_KEY does not look like an age identity (${material.length} chars, ` +
        `starts ${JSON.stringify(material.slice(0, 4))}). An age secret key begins ` +
        "AGE-SECRET-KEY-1. If you used $(pbpaste), the clipboard most likely holds the " +
        "command you copied rather than the key.",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "age-id-"));
  const file = join(dir, "identity.txt");
  writeFileSync(file, material.endsWith("\n") ? material : `${material}\n`);
  chmodSync(file, 0o600);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fact files only — .git internals legitimately differ between a clone and the original. */
function factFiles(dir) {
  if (!existsSync(dir)) return null;
  const out = new Map();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

export function compare(restored, live, wasDirty = false) {
  if (!live) return { verdict: "GONE", detail: "no live corpus to compare against (restored only)" };

  const differences = [];
  for (const [name, content] of restored) {
    if (!live.has(name)) differences.push(`${name} missing from live`);
    else if (live.get(name) !== content) differences.push(`${name} differs`);
  }
  for (const name of live.keys()) if (!restored.has(name)) differences.push(`${name} newer than backup`);

  if (differences.length === 0) return { verdict: "IDENTICAL", detail: `${restored.size} files` };

  // A bundle holds COMMITTED history. When the corpus had uncommitted work at
  // backup time — which the backup said out loud — the live files legitimately
  // differ from the restored ones, and calling that CORRUPT would cry wolf on the
  // one signal that has to stay trustworthy. It is still not protected, so the
  // verdict says so rather than passing quietly.
  if (wasDirty) {
    return {
      verdict: "UNCOMMITTED",
      detail: `${differences.length} file(s) differ because they were never committed — NOT in the backup`,
    };
  }

  // New files and a regenerated index are ordinary drift since the backup was taken.
  const onlyDrift = differences.every(
    (d) => d.endsWith("newer than backup") || d === `${INDEX_FILE} differs`,
  );
  return {
    verdict: onlyDrift ? "DRIFTED" : "CORRUPT",
    detail:
      differences.slice(0, 4).join("; ") +
      (differences.length > 4 ? `; +${differences.length - 4} more` : ""),
  };
}

async function readArchive(args) {
  const archiveIndex = args.indexOf("--archive");
  if (archiveIndex >= 0) {
    const path = args[archiveIndex + 1];
    if (!path || !existsSync(path)) throw new Error(`--archive ${path ?? ""} does not exist.`);
    return { bytes: readFileSync(path), label: path };
  }
  const { makeR2, listKeys, getObject } = await import("./memory-s3.mjs");
  const r2 = makeR2();
  const keys = await listKeys(r2, OBJECT_PREFIX);
  if (keys.length === 0) {
    throw new Error(`No objects under ${OBJECT_PREFIX} in ${r2.bucket} — nothing to restore.`);
  }
  // Keys are "memory/YYYY-MM-DD-<hostname>.tar.age". Prefer this machine's
  // own newest backup — restoring some other host's just because it sorted
  // last tells you nothing about whether THIS machine's backup is good.
  const own = keys.filter((k) => k.endsWith(`-${stableHostname()}.tar.age`));
  const key = (own.length ? own : keys)[own.length ? own.length - 1 : keys.length - 1];
  if (!own.length) {
    console.warn(`WARNING: no backup found for this host (${stableHostname()}) — verifying the newest one in the bucket instead.`);
  }
  return { bytes: await getObject(r2, key), label: `${r2.bucket}/${key}` };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node memory-restore-verify.mjs [--archive <file>] [--keep <dir>]");
    return;
  }
  const keepIndex = args.indexOf("--keep");
  const keepDir = keepIndex >= 0 ? args[keepIndex + 1] : null;

  loadEnv();

  const { bytes, label } = await readArchive(args);
  const work = keepDir ?? mkdtempSync(join(tmpdir(), "memory-restore-"));
  if (keepDir) mkdirSync(keepDir, { recursive: true });
  const encrypted = join(work, "archive.tar.age");
  writeFileSync(encrypted, bytes);

  try {
    const tar = withIdentityFile((identity) =>
      execFileSync("age", ["-d", "-i", identity, encrypted], { maxBuffer: 512 * 1024 * 1024 }),
    );
    execFileSync("tar", ["-xf", "-", "-C", work], { input: tar });

    const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
    console.log(`Restored ${label} — taken ${manifest.takenAt}, ${manifest.corpora.length} corpora`);

    let corrupt = 0;
    let drifted = 0;
    let uncommitted = 0;

    for (const entry of manifest.corpora) {
      const clone = join(work, `restored-${entry.project}`);
      execFileSync("git", ["clone", "-q", join(work, entry.bundle), clone], { stdio: "pipe" });

      const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (head !== entry.head) {
        console.error(
          `CORRUPT  ${entry.project} — bundle HEAD ${head.slice(0, 8)} != manifest ${entry.head.slice(0, 8)}`,
        );
        corrupt++;
        continue;
      }

      const { verdict, detail } = compare(
        factFiles(clone),
        factFiles(join(PROJECTS_DIR, entry.project, "memory")),
        entry.dirty,
      );
      if (verdict === "CORRUPT") corrupt++;
      if (verdict === "DRIFTED") drifted++;
      if (verdict === "UNCOMMITTED") uncommitted++;
      const line = `${verdict.padEnd(10)}${entry.project} — ${detail}`;
      if (verdict === "CORRUPT") console.error(line);
      else console.log(line);
    }

    console.log("");
    if (corrupt > 0) {
      console.error(`RESTORE VERIFICATION FAILED: ${corrupt} corpus/corpora do not match their backup.`);
      process.exit(1);
    }
    console.log(
      `OK — every corpus restored and matched${drifted ? `, ${drifted} drifted since the backup (expected)` : ""}.`,
    );
    if (uncommitted > 0) {
      console.warn(
        `\n${uncommitted} corpus/corpora hold UNCOMMITTED memories that no backup can protect. ` +
          `Commit the memory directory, then re-run the backup.`,
      );
    }
    if (keepDir) console.log(`Restored tree kept at ${keepDir}`);
  } finally {
    if (!keepDir) rmSync(work, { recursive: true, force: true });
  }
}

// Only run as a CLI. Importing this module (from the test suite) must not decrypt
// anything or touch the network — the same guard memory-index.mjs uses.
const isCli = process.argv[1] && process.argv[1].endsWith("memory-restore-verify.mjs");
if (isCli) {
  main().catch((error) => {
    console.error(`\nRESTORE FAILED: ${error.message}`);
    process.exit(1);
  });
}
