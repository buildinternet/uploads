/**
 * Workspace file operations shared by the REST routes (routes/files.ts) and
 * the remote MCP worker (apps/mcp) — one code path for key/body validation,
 * storage I/O, and result shapes. Validation failures throw FileOpError;
 * each surface maps it (HTTP 400 / MCP tool error).
 */
import { publicUrl, storage, storageConfig } from "./storage";
import type { WorkspaceRecord } from "./workspace";

// The freshness floor on overwrite for every bucket. This is the operative lever
// for GitHub embeds: they're proxied through GitHub's Camo/Fastly cache, and
// max-age caps how long Camo serves a stale copy before revalidating against the
// (now-overwritten) origin. Without it, R2's custom-domain default (max-age=14400)
// kept replaced images stale for hours.
export const UPLOAD_CACHE_CONTROL = "public, max-age=60";

const KEY_RE = /^[\w!*'()./-]+$/;

export function badKey(key: string): boolean {
  return (
    !KEY_RE.test(key) ||
    key.length > 1024 ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

/** Invalid input to a file operation (always a caller error, never a storage failure). */
export class FileOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileOpError";
  }
}

export async function putObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ key: string; url: string | null; size: number; contentType: string }> {
  if (badKey(key)) throw new FileOpError("invalid key");
  if (bytes.byteLength === 0) throw new FileOpError("empty body");
  await storage(env, ws).upload(key, bytes, {
    contentType,
    cacheControl: UPLOAD_CACHE_CONTROL,
  });
  return { key, url: publicUrl(storageConfig(env, ws), key), size: bytes.byteLength, contentType };
}

export async function listObjects(
  env: Env,
  ws: WorkspaceRecord,
  opts: { prefix?: string; limit?: number; cursor?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const result = await storage(env, ws).list({ prefix: opts.prefix, limit, cursor: opts.cursor });
  const cfg = storageConfig(env, ws);
  return {
    items: result.items.map((item: { key: string }) => ({
      ...item,
      url: publicUrl(cfg, item.key),
    })),
    cursor: result.cursor ?? null,
  };
}

export async function deleteObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new FileOpError("invalid key");
  await storage(env, ws).delete(key);
  return { key, deleted: true };
}
