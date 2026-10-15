#!/usr/bin/env node
/**
 * Minimal S3 (Cloudflare R2) client — PUT, HEAD, GET, LIST — with SigV4 signing.
 *
 * WHY NOT `@aws-sdk/client-s3`: `~/.claude` has no `node_modules` and
 * `memory-index.mjs` imports only node builtins. That zero-dependency property is
 * what lets this harness survive npm churn, machine moves and ECC re-syncs, and it
 * is worth more than the ~80 lines below. Project's `scripts/lib/r2.mjs` does the
 * same job with the SDK; importing it would tie the global memory system to one
 * project's dependency tree, so the DESIGN is reused and the code is not.
 *
 * R2 is S3-compatible: region is always `auto`, and signing is ordinary SigV4.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const REGION = "auto";

export const R2_ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** `20260115T120000Z` — SigV4 wants the basic ISO form, no punctuation. */
export function amzDate(now) {
  return `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * RFC 3986. `encodeURIComponent` leaves `!'()*` alone and S3 does not, so a key
 * containing them would sign one way, transmit another, and 403 — the least
 * debuggable class of signing bug, because the request looks correct.
 */
function rfc3986(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const encodeKey = (key) => key.split("/").map(rfc3986).join("/");

/**
 * A bucket created with a jurisdiction (EU, FedRAMP) is NOT reachable on the
 * account's default endpoint — it needs `<account>.<jurisdiction>.r2...`. The
 * default endpoint answers a jurisdictional bucket with a bare `Access Denied`,
 * which reads as a permissions problem and sends you off rebuilding API tokens.
 * It is a routing problem. (Learned the expensive way — project memory
 * `myproject-backups-h13`.)
 */
export function defaultEndpoint(accountId, jurisdiction) {
  const scope = jurisdiction ? `${jurisdiction.toLowerCase()}.` : "";
  return `https://${accountId}.${scope}r2.cloudflarestorage.com`;
}

export function makeR2(env = process.env) {
  const endpoint = env.R2_ENDPOINT || defaultEndpoint(env.R2_ACCOUNT_ID, env.R2_JURISDICTION);
  const required = env.R2_ENDPOINT ? R2_ENV_KEYS.filter((k) => k !== "R2_ACCOUNT_ID") : R2_ENV_KEYS;
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `R2 is not configured — missing ${missing.join(", ")}. ` +
        `Put them in ~/.claude/.env.memory-backup (chmod 600).`,
    );
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/**
 * The pure half — separated so a test can assert a signature against fixed inputs
 * with no network and no real credentials.
 */
export function signRequest({
  method,
  path,
  query = {},
  payloadHash,
  host,
  now,
  accessKeyId,
  secretAccessKey,
}) {
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`)
    .join("&");

  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), REGION), SERVICE),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    canonicalQuery,
    headers: {
      ...headers,
      Authorization:
        `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function send(r2, { method, key = "", body, query, accept404 = false }) {
  const path = key ? `/${rfc3986(r2.bucket)}/${encodeKey(key)}` : `/${rfc3986(r2.bucket)}`;
  const host = new URL(r2.endpoint).host;
  const payloadHash = sha256Hex(body ?? "");

  const { canonicalQuery, headers } = signRequest({
    method,
    path,
    query,
    payloadHash,
    host,
    now: new Date(),
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
  });

  const url = `${r2.endpoint}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const response = await fetch(url, { method, headers, body });

  if (response.status === 404 && accept404) return null;
  if (!response.ok) {
    // R2 puts the reason in an XML body; without it the caller sees a bare status
    // and cannot tell a bad key from a bad bucket from a jurisdiction mismatch.
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error(`R2 ${method} ${key || r2.bucket} failed: HTTP ${response.status} ${detail}`);
  }
  return response;
}

export async function putObject(r2, key, body) {
  await send(r2, { method: "PUT", key, body });
}

/** `null` when the object does not exist — absence is an answer, not an error. */
export async function headObject(r2, key) {
  const response = await send(r2, { method: "HEAD", key, accept404: true });
  if (!response) return null;
  return { size: Number(response.headers.get("content-length") ?? 0) };
}

export async function getObject(r2, key) {
  const response = await send(r2, { method: "GET", key });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Keys under a prefix, sorted. Deliberately a regex over the XML rather than a
 * parser dependency: the only field needed is <Key>, which ListObjectsV2 escapes,
 * so there is no nesting to get wrong.
 */
export async function listKeys(r2, prefix) {
  const response = await send(r2, {
    method: "GET",
    query: { "list-type": "2", prefix, "max-keys": "1000" },
  });
  const xml = await response.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();
}
