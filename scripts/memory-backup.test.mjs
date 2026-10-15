// Tests for the memory backup path: env parsing, corpus discovery, SigV4 signing,
// and — most importantly — that the restore verifier CAN FAIL. A verifier that
// always passes proves nothing, and it is the one component whose silence is
// indistinguishable from success.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseEnvFile, findCorpora } from "./memory-backup.mjs";
import { compare } from "./memory-restore-verify.mjs";
import { signRequest, defaultEndpoint, makeR2, amzDate } from "./memory-s3.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "memory-backup-test-"));

function corpus(root, slug, files) {
  const dir = join(root, slug, "memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("parseEnvFile", () => {
  test("reads plain, exported, quoted and commented lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "R2_BUCKET=memories",
        'export AGE_PUBLIC_KEY="age1abc"',
        "R2_ACCOUNT_ID='acct'",
        "",
        "  ",
        "not a pair",
      ].join("\n"),
    );
    assert.deepEqual(parsed, {
      R2_BUCKET: "memories",
      AGE_PUBLIC_KEY: "age1abc",
      R2_ACCOUNT_ID: "acct",
    });
  });

  test("keeps '=' inside a value", () => {
    assert.equal(parseEnvFile("R2_SECRET_ACCESS_KEY=abc=def==").R2_SECRET_ACCESS_KEY, "abc=def==");
  });
});

describe("findCorpora", () => {
  test("finds directories with fact files and skips index-only ones", () => {
    const root = scratch();
    corpus(root, "proj-a", { "MEMORY.md": "# Memory Index\n", "a-fact.md": "x" });
    corpus(root, "proj-empty", { "MEMORY.md": "# Memory Index\n" });
    mkdirSync(join(root, "no-memory-dir"), { recursive: true });

    const found = findCorpora(root).map((c) => c.project);
    rmSync(root, { recursive: true, force: true });

    assert.deepEqual(found, ["proj-a"], "a corpus with only an index has nothing worth backing up");
  });

  test("returns an empty list rather than throwing when there are no projects", () => {
    assert.deepEqual(findCorpora(join(tmpdir(), "definitely-not-here-9f4")), []);
  });
});

describe("restore verification", () => {
  const map = (obj) => new Map(Object.entries(obj));

  test("identical content passes", () => {
    assert.equal(compare(map({ "a.md": "same" }), map({ "a.md": "same" })).verdict, "IDENTICAL");
  });

  // The property the whole drill rests on.
  test("CHANGED CONTENT FAILS — the verifier can actually fail", () => {
    assert.equal(compare(map({ "a.md": "original" }), map({ "a.md": "tampered" })).verdict, "CORRUPT");
  });

  test("a file missing from the live corpus fails", () => {
    assert.equal(compare(map({ "a.md": "x", "b.md": "y" }), map({ "a.md": "x" })).verdict, "CORRUPT");
  });

  test("new files and a regenerated index are drift, not corruption", () => {
    const verdict = compare(
      map({ "a.md": "x", "MEMORY.md": "old index" }),
      map({ "a.md": "x", "MEMORY.md": "new index", "b.md": "written since" }),
    );
    assert.equal(verdict.verdict, "DRIFTED");
  });

  // A bundle holds committed history only. Calling that CORRUPT would cry wolf on
  // the one signal that has to stay trustworthy — but it must not pass silently.
  test("differences in a corpus that was dirty at backup time report as UNCOMMITTED", () => {
    const verdict = compare(
      map({ "a.md": "committed" }),
      map({ "a.md": "edited, never committed" }),
      true,
    );
    assert.equal(verdict.verdict, "UNCOMMITTED");
    assert.match(verdict.detail, /NOT in the backup/);
  });

  test("no live corpus is reported, not silently passed", () => {
    assert.equal(compare(map({ "a.md": "x" }), null).verdict, "GONE");
  });
});

describe("S3 signing", () => {
  const FIXED = {
    method: "PUT",
    path: "/bucket/memory/2026-01-15.tar.age",
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    host: "acct.eu.r2.cloudflarestorage.com",
    now: new Date("2026-01-15T12:00:00Z"),
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  };

  test("is deterministic for identical inputs", () => {
    assert.equal(signRequest(FIXED).headers.Authorization, signRequest(FIXED).headers.Authorization);
  });

  test("a different secret produces a different signature", () => {
    assert.notEqual(
      signRequest(FIXED).headers.Authorization,
      signRequest({ ...FIXED, secretAccessKey: "other" }).headers.Authorization,
    );
  });

  test("signs the credential scope with the request date and the R2 region", () => {
    const auth = signRequest(FIXED).headers.Authorization;
    assert.match(auth, /Credential=AKIAEXAMPLE\/20260115\/auto\/s3\/aws4_request/);
    assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  });

  test("the secret never appears in the signed output", () => {
    assert.ok(
      !JSON.stringify(signRequest(FIXED)).includes("secret"),
      "a signature must not leak the key it was made with",
    );
  });

  test("amzDate uses the basic ISO form SigV4 requires", () => {
    assert.equal(amzDate(new Date("2026-01-15T12:00:00.123Z")), "20260115T120000Z");
  });
});

describe("R2 endpoint", () => {
  // An EU bucket on the default endpoint answers `Access Denied`, which reads as a
  // permissions problem and sends you rebuilding tokens. It is a routing problem.
  test("a jurisdiction changes the host", () => {
    assert.equal(defaultEndpoint("acct", "eu"), "https://acct.eu.r2.cloudflarestorage.com");
    assert.equal(defaultEndpoint("acct", undefined), "https://acct.r2.cloudflarestorage.com");
  });

  test("missing configuration names the missing keys, never the values", () => {
    assert.throws(() => makeR2({ R2_BUCKET: "b" }), /missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID/);
  });

  test("an explicit endpoint makes the account id unnecessary", () => {
    const r2 = makeR2({
      R2_ENDPOINT: "http://127.0.0.1:9000/",
      R2_BUCKET: "b",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    });
    assert.equal(r2.endpoint, "http://127.0.0.1:9000", "a trailing slash would double up in the signed path");
  });
});
