#!/usr/bin/env node
// Self-reported health, so the daily cloud alert job never needs SSH access to
// any machine — each machine pushes its own status to GitHub, the cloud job
// only ever reads via the GitHub API. That's the actual constraint: a cloud
// sandbox can't reach this Mac's or any VPS's SSH keys, so "monitoring" has to
// mean "read what the machine already told you," not "go check it yourself."
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { stableHostname } from "./memory-backup.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const STATUS_DIR = join(CLAUDE_DIR, "status");
const BACKUP_LOG = join(CLAUDE_DIR, "logs", "memory-backup.log");
const CAPTURE_LOG = join(CLAUDE_DIR, "logs", "memory-auto-capture.log");

function diskFreePercent() {
  try {
    const out = execSync("df -P " + homedir(), { encoding: "utf8" });
    const line = out.trim().split("\n").at(-1);
    const usedPercent = Number(line.split(/\s+/).find((f) => f.endsWith("%")).replace("%", ""));
    return 100 - usedPercent;
  } catch {
    return null;
  }
}

function lastJsonlEntry(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  if (!lines.length || !lines.at(-1)) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

// memory-backup.log is plain prose, not JSONL — summarize instead of parsing.
// The run often ends with a trailing hint line (e.g. "Restore drill: ...") after
// the real result, so check the last few lines, not just the very last one.
function backupLogSummary(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const tail = lines.slice(-5).join("\n");
  return {
    lastLine: lines.at(-1) ?? "",
    looksSuccessful: /uploaded and verified/i.test(tail) || /already current|no change/i.test(tail),
    lastModified: statSync(path).mtime.toISOString(),
  };
}

function main() {
  const host = stableHostname();
  mkdirSync(STATUS_DIR, { recursive: true });

  const status = {
    hostname: host,
    reportedAt: new Date().toISOString(),
    diskFreePercent: diskFreePercent(),
    lastBackup: backupLogSummary(BACKUP_LOG),
    lastCaptureLogEntry: lastJsonlEntry(CAPTURE_LOG),
  };

  writeFileSync(join(STATUS_DIR, `${host}.json`), JSON.stringify(status, null, 2) + "\n");

  try {
    execSync(`git -C "${CLAUDE_DIR}" add status/${host}.json -- .`, { stdio: "pipe" });
    execSync(`git -C "${CLAUDE_DIR}" commit -m "health report: ${host}" -- status/${host}.json`, { stdio: "pipe" });
    execSync(`git -C "${CLAUDE_DIR}" push`, { stdio: "pipe" });
    console.log(`health report pushed for ${host}`);
  } catch (err) {
    // Nothing changed (same disk%, same log tail) is the common case, not an error.
    if (!/nothing to commit/.test(err.stdout?.toString() ?? "")) {
      console.error(`health report commit/push failed: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.log(`no change for ${host}, skipped`);
    }
  }
}

main();
