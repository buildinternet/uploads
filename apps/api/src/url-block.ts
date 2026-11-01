/**
 * Operator takedowns ("Block URL" on /admin/blocks). A block writes a
 * `url_block` row (reason, actor, time) and a `read_gate` row for the URL's
 * object key and its poster key, so the read-gate Worker serves the held card
 * for an image and a 404 for anything else. It is not a hold: no metadata,
 * no file events, no workspace-wide effect. `read-gate.ts` deletes skip keys
 * with a `url_block` row, so a hold release or a file delete does not lift a
 * block. Unblock drops the gate rows unless the file is still held.
 */

import { ValidationError } from "@uploads/errors";
import { HOSTED_ACTIVE_CONTENT_HOSTS } from "./active-content-hosts";
import { dbFor } from "./db-session";
import { POSTER_KEY_PREFIX, posterKeyFor } from "./poster-presentation";
import { HOSTED_READ_LANE, readGateDeletes, readGateInserts } from "./read-gate";
import { hostOf } from "@uploads/storage";
import { isKeyHeld } from "./upload-hold-read";

export const URL_BLOCK_REASON_MAX = 500;
const LIST_LIMIT = 200;

export interface UrlBlock {
  url: string;
  objectKey: string;
  reason: string;
  blockedBy: string;
  blockedAt: string;
}

export interface BlockTarget {
  /** The URL as given, normalized to `https://host/path`. */
  url: string;
  /** Public object key, `<workspace>/<key>`. */
  objectKey: string;
  workspace: string;
  /** Key inside the workspace. */
  key: string;
}

function hostedHosts(env: Pick<Env, "EMBED_PUBLIC_BASE_URL">): Set<string> {
  const hosts = new Set(HOSTED_ACTIVE_CONTENT_HOSTS);
  const embed = hostOf(env.EMBED_PUBLIC_BASE_URL);
  if (embed) hosts.add(embed);
  return hosts;
}

function invalid(message: string): ValidationError {
  return new ValidationError(message, { code: "invalid_url" });
}

/**
 * The object key the read-gate Worker would look up for this URL. Same
 * rules as `objectKeyFromUrl` in apps/read-gate: decoded path segments, and
 * a `/cdn-cgi/image/<opts>/` variant maps to its source key.
 */
export function parseBlockTarget(
  env: Pick<Env, "EMBED_PUBLIC_BASE_URL">,
  raw: unknown,
): BlockTarget {
  if (typeof raw !== "string" || !raw.trim()) throw invalid("url is required");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid("url must be a full URL");
  }
  const hosts = hostedHosts(env);
  if (!hosts.has(url.hostname.toLowerCase())) {
    throw invalid(`url must be on a hosted host (${[...hosts].join(", ")})`);
  }
  let path: string;
  try {
    path = url.pathname
      .replace(/^\/+/, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw invalid("url path is not valid");
  }
  if (path.startsWith("cdn-cgi/image/")) {
    const rest = path.slice("cdn-cgi/image/".length);
    const slash = rest.indexOf("/");
    path = slash < 0 ? "" : rest.slice(slash + 1);
  }
  const slash = path.indexOf("/");
  if (slash <= 0 || slash === path.length - 1) {
    throw invalid("url must point at a file, like https://storage.uploads.sh/<workspace>/<key>");
  }
  const workspace = path.slice(0, slash);
  return {
    url: `https://${url.hostname.toLowerCase()}/${path}`,
    objectKey: path,
    workspace,
    key: path.slice(slash + 1),
  };
}

/** The URL's key plus its video/PDF poster, unless the URL is the poster. */
function gateKeys(target: BlockTarget): string[] {
  if (target.key.startsWith(POSTER_KEY_PREFIX)) return [target.objectKey];
  return [target.objectKey, `${target.workspace}/${posterKeyFor(target.key)}`];
}

export async function blockUrl(
  env: Env,
  target: BlockTarget,
  reason: string,
  actor: string,
  now = new Date(),
): Promise<UrlBlock> {
  const db = dbFor(env);
  const at = now.toISOString();
  const keys = gateKeys(target);
  await db.batch([
    ...keys.map((objectKey) =>
      db
        .prepare(
          `INSERT INTO url_block (lane, object_key, url, reason, blocked_by, blocked_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(lane, object_key) DO UPDATE SET
             url = excluded.url, reason = excluded.reason,
             blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`,
        )
        .bind(HOSTED_READ_LANE, objectKey, target.url, reason, actor, at),
    ),
    ...readGateInserts(db, keys),
  ]);
  console.log({ event: "url_blocked", objectKey: target.objectKey, actor });
  return { url: target.url, objectKey: target.objectKey, reason, blockedBy: actor, blockedAt: at };
}

/** Lifts the block. Gate rows stay when the file is still held for review. */
export async function unblockUrl(
  env: Env,
  target: BlockTarget,
  actor: string,
): Promise<{ removed: boolean; stillHeld: boolean }> {
  const db = dbFor(env);
  const keys = gateKeys(target);
  const stillHeld = await isKeyHeld(env, target.workspace, target.key);
  const results = await db.batch([
    ...keys.map((objectKey) =>
      db
        .prepare(`DELETE FROM url_block WHERE lane = ? AND object_key = ?`)
        .bind(HOSTED_READ_LANE, objectKey),
    ),
    // Runs after the url_block deletes, so readGateDeletes' block check passes.
    ...(stillHeld ? [] : readGateDeletes(db, keys)),
  ]);
  const removed = results
    .slice(0, keys.length)
    .some((r) => ((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0);
  console.log({ event: "url_unblocked", objectKey: target.objectKey, actor, stillHeld });
  return { removed, stillHeld };
}

/** Newest first, one entry per blocked URL (poster rows fold into it). */
export async function listUrlBlocks(env: Env): Promise<UrlBlock[]> {
  const { results } = await dbFor(env)
    .prepare(
      `SELECT object_key, url, reason, blocked_by, blocked_at FROM url_block
       WHERE lane = ? ORDER BY blocked_at DESC LIMIT ?`,
    )
    .bind(HOSTED_READ_LANE, LIST_LIMIT * 2)
    .all<{
      object_key: string;
      url: string;
      reason: string;
      blocked_by: string;
      blocked_at: string;
    }>();
  const byUrl = new Map<string, UrlBlock>();
  for (const row of results ?? []) {
    const existing = byUrl.get(row.url);
    // The poster row shares the URL; report the URL's own key.
    if (existing && row.object_key.includes(`/${POSTER_KEY_PREFIX}`)) continue;
    byUrl.set(row.url, {
      url: row.url,
      objectKey: row.object_key,
      reason: row.reason,
      blockedBy: row.blocked_by,
      blockedAt: row.blocked_at,
    });
  }
  return [...byUrl.values()].slice(0, LIST_LIMIT);
}
