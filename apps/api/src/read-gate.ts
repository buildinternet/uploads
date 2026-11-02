/**
 * Rows the hosted read-gate Worker checks. Keys are the public object key
 * (`<prefix><key>`), not a workspace plus a hash. Whether a key is hosted,
 * and which prefix it uses, comes from `resolveObjectLane` — the same lookup
 * a legacy move into the held bucket uses — so a key left in the shared
 * bucket after a switch to BYO still gets a row. A key that resolves on a
 * BYO lane does not.
 */

import type { D1Queryable } from "./db-session";
import { posterKeyFor } from "./poster-presentation";
import { createLaneResolver, isSharedLane, publicUrl } from "./storage";
import type { WorkspaceRecord } from "./workspace";

/** Lane value stored for every hosted-bucket key. The three public hosts share it. */
export const HOSTED_READ_LANE = "hosted";

export async function hostedGateObjectKeys(
  env: Env,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<string[]> {
  const resolver = createLaneResolver(env, ws);
  let activePrefix: string | null | undefined;
  const out = new Set<string>();
  for (const key of keys) {
    const lane = await resolver.resolve(key);
    // A moved hold is gone from every public lane. The URL it had is the
    // active lane's prefix, which is where delete and a re-hold must look.
    const prefix = lane
      ? isSharedLane(lane.config)
        ? (lane.config.prefix ?? "")
        : null
      : await sharedActivePrefix();
    if (prefix === null) continue;
    out.add(`${prefix}${key}`);
    out.add(`${prefix}${posterKeyFor(key)}`);
  }
  return [...out];

  async function sharedActivePrefix(): Promise<string | null> {
    if (activePrefix === undefined) {
      const config = await resolver.activeConfig();
      activePrefix = isSharedLane(config) ? (config.prefix ?? "") : null;
    }
    return activePrefix;
  }
}

/** Public keys for objects just written to `config`. No storage probe. */
export function gateObjectKeysOnLane(
  config: Parameters<typeof isSharedLane>[0] & { prefix?: string },
  keys: string[],
): string[] {
  if (!isSharedLane(config)) return [];
  const prefix = config.prefix ?? "";
  const out: string[] = [];
  for (const key of keys) out.push(`${prefix}${key}`, `${prefix}${posterKeyFor(key)}`);
  return out;
}

export function readGateInserts(db: D1Queryable, objectKeys: string[]) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `INSERT INTO read_gate (lane, object_key) VALUES (?, ?)
         ON CONFLICT(lane, object_key) DO NOTHING`,
      )
      .bind(HOSTED_READ_LANE, objectKey),
  );
}

/** An operator block (`url-block.ts`) keeps its gate row through every delete below. */
const NOT_OPERATOR_BLOCKED = `NOT EXISTS (
  SELECT 1 FROM url_block u
  WHERE u.lane = read_gate.lane AND u.object_key = read_gate.object_key
)`;

export function readGateDeletes(db: D1Queryable, objectKeys: string[]) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `DELETE FROM read_gate WHERE lane = ? AND object_key = ? AND ${NOT_OPERATOR_BLOCKED}`,
      )
      .bind(HOSTED_READ_LANE, objectKey),
  );
}

/**
 * Gate inserts that do nothing once this hash is released. A repair that
 * read `held` and then lost the race must not block the public URL.
 */
export function readGateInsertsUnlessReleased(
  db: D1Queryable,
  objectKeys: string[],
  workspace: string,
  contentSha256: string,
) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `INSERT INTO read_gate (lane, object_key)
         SELECT ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM blob_hold
           WHERE workspace = ? AND content_sha256 = ? AND state = 'released'
         )
         ON CONFLICT(lane, object_key) DO NOTHING`,
      )
      .bind(HOSTED_READ_LANE, objectKey, workspace, contentSha256),
  );
}

/** Gate inserts that apply only when this call's hold write stored `at`. */
export function readGateInsertsForHold(
  db: D1Queryable,
  objectKeys: string[],
  workspace: string,
  contentSha256: string,
  at: string,
) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `INSERT INTO read_gate (lane, object_key)
         SELECT ?, ?
         WHERE EXISTS (
           SELECT 1 FROM blob_hold
           WHERE workspace = ? AND content_sha256 = ? AND state = 'held' AND at = ?
         )
         ON CONFLICT(lane, object_key) DO NOTHING`,
      )
      .bind(HOSTED_READ_LANE, objectKey, workspace, contentSha256, at),
  );
}

/** Gate deletes that apply only when this call's release write stored `at`. */
export function readGateDeletesForRelease(
  db: D1Queryable,
  objectKeys: string[],
  workspace: string,
  contentSha256: string,
  at: string,
) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `DELETE FROM read_gate
         WHERE lane = ? AND object_key = ?
           AND ${NOT_OPERATOR_BLOCKED}
           AND EXISTS (
             SELECT 1 FROM blob_hold
             WHERE workspace = ? AND content_sha256 = ? AND state = 'released' AND at = ?
           )`,
      )
      .bind(HOSTED_READ_LANE, objectKey, workspace, contentSha256, at),
  );
}

function missingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table");
}

/** Best-effort insert used when a write lands on a key that is already held. */
export async function insertHostedReadGate(
  env: Env,
  db: D1Queryable,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<void> {
  const objectKeys = await hostedGateObjectKeys(env, ws, keys);
  if (objectKeys.length === 0) return;
  try {
    await db.batch(readGateInserts(db, objectKeys));
  } catch (err) {
    if (missingTable(err)) return;
    throw err;
  }
}

/** Drop the gate rows for these keys and their posters. */
export async function deleteHostedReadGate(
  env: Env,
  db: D1Queryable,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<void> {
  await deleteReadGateKeys(db, await hostedGateObjectKeys(env, ws, keys));
}

/** Drop these public object keys. Each delete is a primary-key lookup. */
export async function deleteReadGateKeys(db: D1Queryable, objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  try {
    await db.batch(readGateDeletes(db, objectKeys));
  } catch (err) {
    if (missingTable(err)) return;
    throw err;
  }
}

/** Prefix delete for workspace teardown, operator blocks included. The bound is the primary key, not a scan. */
export async function deleteReadGateForWorkspace(
  db: D1Queryable,
  workspaceName: string,
): Promise<void> {
  const prefix = `${workspaceName}/`;
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  try {
    await db.batch(
      ["url_block", "read_gate"].map((table) =>
        db
          .prepare(`DELETE FROM ${table} WHERE lane = ? AND object_key >= ? AND object_key < ?`)
          .bind(HOSTED_READ_LANE, prefix, upper),
      ),
    );
  } catch (err) {
    if (missingTable(err)) return;
    console.error({ event: "read_gate_delete_failed", workspace: workspaceName, err });
  }
}

/** How long a reviewer link works. The gate refuses anything over 15 minutes. */
export const REVIEW_URL_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `<expiry>.<sig>` for `?review=`. Same scheme as `verifyReview` in
 * apps/read-gate/src/review.ts: base64url HMAC-SHA256 over
 * `lane \n object key \n expiry` (unix seconds).
 */
export async function reviewToken(
  secret: string,
  objectKey: string,
  expiry: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${HOSTED_READ_LANE}\n${objectKey}\n${expiry}`),
  );
  return `${expiry}.${base64url(sig)}`;
}

/**
 * A short-lived link that shows a held hosted file to whoever has it. Only
 * mint one for a workspace member, and never put one in a PR comment.
 * Null when the secret is unset, the key is on a BYO lane, or the key is
 * in no lane.
 */
export async function reviewUrlsFor(
  env: Env,
  ws: WorkspaceRecord,
  keys: string[],
  nowMs = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const secret = env.READ_GATE_REVIEW_SECRET;
  if (!secret || keys.length === 0) return out;
  const resolver = createLaneResolver(env, ws);
  const expiry = Math.floor(nowMs / 1000) + REVIEW_URL_TTL_SECONDS;
  for (const key of keys) {
    try {
      const lane = await resolver.resolve(key);
      if (!lane || !isSharedLane(lane.config)) continue;
      const url = publicUrl(lane.config, key);
      if (!url) continue;
      const token = await reviewToken(secret, `${lane.config.prefix ?? ""}${key}`, expiry);
      out.set(key, `${url}?review=${token}`);
    } catch (err) {
      // A link is a convenience. The held list still answers without one.
      console.error({ event: "review_url_failed", err });
    }
  }
  return out;
}
