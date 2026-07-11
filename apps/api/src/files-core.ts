/**
 * Workspace file operations shared by the REST routes (routes/files.ts) and
 * the remote MCP worker (apps/mcp) — one code path for key/body validation,
 * storage I/O, and result shapes. Validation failures throw FileOpError;
 * each surface maps it (HTTP 400 / MCP tool error).
 */
import type { Files } from "@uploads/storage";
import { checkPutBudget } from "./budget";
import { inspectUpload, resolveUploadPolicy } from "./guards";
import { checkKeyPolicy, resolveKeyPolicy } from "./key-policy";
import {
  contentSha256Hex,
  provenanceForResponse,
  sanitizeProvenance,
  type ProvenanceMap,
} from "./provenance";
import { publicUrl, storage, storageConfig } from "./storage";
import { getWorkspaceUsage, recordUsageSafe } from "./usage";
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

/** Sanitize a bare basename for object keys. */
export function sanitizeKeyBasename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "file";
}

/** Short url-safe id for auto-prefix paths (`f/<id>/…`). */
export function shortUploadId(bytes = 9): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Bare filenames (no `/`) get `f/<shortid>/<name>` so the workspace root doesn't
 * accumulate loose objects. Nested keys (`screenshots/…`, `gh/…`) pass through.
 * Default ON; opt out with `WorkspaceRecord.autoPrefixBareKeys === false`.
 */
export function governUploadKey(key: string, autoPrefix = true): string {
  if (!autoPrefix || key.includes("/")) return key;
  return `f/${shortUploadId()}/${sanitizeKeyBasename(key)}`;
}

/** Workspace fields that affect key governance and prefix/depth policy. */
export type KeyPolicyRecord = Pick<
  WorkspaceRecord,
  "autoPrefixBareKeys" | "allowedKeyPrefixes" | "maxKeyDepth"
>;

/**
 * Bare-key governance + per-workspace prefix/depth policy. Shared by put and
 * presign so both surfaces reject the same keys.
 */
export function finalizeUploadKey(key: string, ws: KeyPolicyRecord): string {
  const finalKey = governUploadKey(key, ws.autoPrefixBareKeys !== false);
  if (badKey(finalKey)) throw new FileOpError("invalid key");

  const violation = checkKeyPolicy(finalKey, resolveKeyPolicy(ws));
  if (violation) {
    const { message, code, ...extra } = violation;
    throw new FileOpError(message, 400, { code, ...extra });
  }
  return finalKey;
}

/**
 * Rejected input to a file operation (always a caller error, never a storage
 * failure). Carries the REST status and error body so both surfaces report the
 * same policy: HTTP responds with them; MCP renders `message` in the tool error.
 */
export class FileOpError extends Error {
  readonly status: 400 | 413 | 415 | 429 | 507;
  readonly body: Record<string, unknown>;

  constructor(
    message: string,
    status: 400 | 413 | 415 | 429 | 507 = 400,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FileOpError";
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

/** Size of an existing object, or `null` if missing / unreadable (metering may drift). */
async function existingSize(store: Files, key: string): Promise<number | null> {
  try {
    const meta = await store.head(key);
    return meta.size ?? 0;
  } catch {
    return null;
  }
}

/**
 * Upload with the workspace's guardrails applied: size cap and content-type
 * allowlist, the stored content type sniffed from the bytes rather than taken
 * from the caller — see guards.ts.
 *
 * After a successful write, updates the workspace usage ledger (overwrite-aware).
 * Metering is best-effort and never fails the upload.
 */
export async function putObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  bytes: Uint8Array,
  workspaceName: string,
  opts?: { provenance?: Record<string, string> },
): Promise<{
  key: string;
  url: string | null;
  size: number;
  contentType: string;
  metadata?: ProvenanceMap;
}> {
  const finalKey = finalizeUploadKey(key, ws);
  if (bytes.byteLength === 0) throw new FileOpError("empty body");

  const inspection = inspectUpload(bytes, resolveUploadPolicy(ws));
  if (!inspection.ok) {
    const { error, ...extra } = inspection.body as { error: string } & Record<string, unknown>;
    throw new FileOpError(error, inspection.status, extra);
  }

  const store = await storage(env, ws);
  const prev = await existingSize(store, finalKey);
  const newSize = bytes.byteLength;
  const deltaBytes = prev === null ? newSize : newSize - prev;

  const usage = await getWorkspaceUsage(env.DB, workspaceName);
  const denial = checkPutBudget(usage, ws, { bytes: deltaBytes, uploads: 1 });
  if (denial) throw new FileOpError(denial.message, denial.status, denial.detail);

  // Client headers first; always attach content-sha256 of the final stored body
  // (never trust a client-supplied hash).
  const metadata: ProvenanceMap = {
    ...sanitizeProvenance(opts?.provenance, { clientOnly: true }),
    "content-sha256": await contentSha256Hex(bytes),
  };

  await store.upload(finalKey, bytes, {
    contentType: inspection.contentType,
    cacheControl: UPLOAD_CACHE_CONTROL,
    metadata,
  });

  await recordUsageSafe(env.DB, workspaceName, {
    bytes: deltaBytes,
    objects: prev === null ? 1 : 0,
    uploads: 1,
  });

  return {
    key: finalKey,
    url: publicUrl(await storageConfig(env, ws), finalKey),
    size: newSize,
    contentType: inspection.contentType,
    metadata,
  };
}

/** Shape HEAD/list-friendly metadata for API JSON. */
export function headObjectJson(
  key: string,
  meta: {
    size?: number;
    type?: string;
    lastModified?: number;
    metadata?: Record<string, string>;
  },
  url: string | null,
) {
  const provenance = provenanceForResponse(meta.metadata ?? undefined);
  return {
    key,
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
    url,
    ...(provenance ? { metadata: provenance } : {}),
  };
}

export async function listObjects(
  env: Env,
  ws: WorkspaceRecord,
  opts: { prefix?: string; limit?: number; cursor?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const store = await storage(env, ws);
  const result = await store.list({ prefix: opts.prefix, limit, cursor: opts.cursor });
  const cfg = await storageConfig(env, ws);
  return {
    items: result.items.map((item: { key: string }) => ({
      ...item,
      url: publicUrl(cfg, item.key),
    })),
    cursor: result.cursor ?? null,
  };
}

/** Delete an object and decrement the workspace ledger when size was known. */
export async function deleteObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  workspaceName: string,
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new FileOpError("invalid key");

  const store = await storage(env, ws);
  const prev = await existingSize(store, key);

  await store.delete(key);

  if (prev !== null) {
    await recordUsageSafe(env.DB, workspaceName, {
      bytes: -prev,
      objects: -1,
      uploads: 0,
    });
  }

  return { key, deleted: true };
}
