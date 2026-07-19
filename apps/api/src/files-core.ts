/**
 * Workspace file operations shared by the REST routes (routes/files.ts) and
 * the remote MCP worker (apps/mcp) — one code path for key/body validation,
 * storage I/O, and result shapes. Validation failures throw AppError subclasses
 * from `@uploads/errors`; REST serializes via `respondError`, MCP surfaces
 * `message` in the tool error.
 */
import { NotFoundError, ValidationError } from "@uploads/errors";
import type { Files } from "@uploads/storage";
import {
  budgetDenialError,
  checkPutBudget,
  resolveBudgetLimits,
  uploadBudgetDenial,
} from "./budget";
import { deleteFileMetadata, replaceFileMetadata, validateMetadataEntries } from "./file-metadata";
import { DEFAULT_MAX_UPLOAD_BYTES, inspectUpload, resolveUploadPolicy } from "./guards";
import { checkKeyPolicy, resolveKeyPolicy } from "./key-policy";
import {
  contentSha256Hex,
  provenanceForResponse,
  sanitizeProvenance,
  type ProvenanceMap,
} from "./provenance";
import { objectPublicUrls, storage, storageConfig } from "./storage";
import { getWorkspaceUsage, recordUsageSafe, releaseUploadsSafe, reserveUploads } from "./usage";
import { objectVisibility, VISIBILITY_META_KEY, type Visibility } from "./visibility";
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
  if (badKey(finalKey)) throw new ValidationError("invalid key", { code: "invalid_key" });

  const violation = checkKeyPolicy(finalKey, resolveKeyPolicy(ws));
  if (violation) {
    const { message, code, ...extra } = violation;
    throw new ValidationError(message, { code, details: extra });
  }
  return finalKey;
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
  opts?: {
    provenance?: Record<string, string>;
    visibility?: Visibility;
    /**
     * Custom queryable metadata (D1 `file_metadata`), distinct from the R2
     * `provenance` bag above. When present (even `{}`), this call fully
     * replaces any metadata already stored for the key — delete-then-set —
     * so an overwrite never leaves stale rows from a prior put. Omit
     * entirely (undefined) to leave existing metadata untouched. Every
     * caller follows this contract: the REST PUT route passes `undefined`
     * when the request had no custom (non-provenance) `X-Uploads-Meta-*`
     * headers, and the MCP `put`/`attach` tools pass `undefined` when their
     * `metadata` argument was omitted.
     */
    metadata?: Record<string, string>;
  },
): Promise<{
  key: string;
  url: string | null;
  /** Same object on the embed host when dual-host cache policy applies; else null. */
  embedUrl: string | null;
  size: number;
  contentType: string;
  /** True when this put overwrote an existing key (messaging only; no confirm). */
  replaced: boolean;
  metadata?: ProvenanceMap;
  visibility?: Visibility;
}> {
  const finalKey = finalizeUploadKey(key, ws);
  if (bytes.byteLength === 0) throw new ValidationError("empty body", { code: "empty_body" });

  // Validate custom metadata before any write so a bad key/value or a
  // cap breach rejects the whole upload instead of landing bytes first.
  if (opts?.metadata) validateMetadataEntries(opts.metadata);

  const inspection = inspectUpload(bytes, resolveUploadPolicy(ws));
  if (!inspection.ok) throw inspection.error;

  const store = await storage(env, ws);
  // Pre-upload head: size for ledger delta. files-sdk upload() has no
  // replaced/exists flag on UploadResult, so we derive it here.
  const prev = await existingSize(store, finalKey);
  const replaced = prev !== null;
  const newSize = bytes.byteLength;
  const deltaBytes = prev === null ? newSize : newSize - prev;

  const usage = await getWorkspaceUsage(env.DB, workspaceName);
  const denial = checkPutBudget(usage, ws, { bytes: deltaBytes, uploads: 1 });
  if (denial) throw budgetDenialError(denial);

  // The read-side check above handles the storage cap and rejects
  // obviously-spent budgets cheaply, but it races with concurrent puts at the
  // upload-cap boundary. Reserve the upload atomically (guarded D1 increment)
  // before the R2 write; the reservation IS the upload count, so the post-put
  // recordUsageSafe below must not count it again, and a failed write
  // releases it.
  const { maxUploadsPerPeriod } = resolveBudgetLimits(ws);
  const reservation = await reserveUploads(env.DB, workspaceName, 1, maxUploadsPerPeriod);
  if (!reservation.ok) {
    throw budgetDenialError(uploadBudgetDenial(reservation.usage, reservation.maxUploadsPerPeriod));
  }

  // Client headers first; always attach content-sha256 of the final stored body
  // (never trust a client-supplied hash). Visibility lives alongside provenance
  // in the same custom-metadata bag but is tracked separately (not client-free-form).
  const provenance: ProvenanceMap = {
    ...sanitizeProvenance(opts?.provenance, { clientOnly: true }),
    "content-sha256": await contentSha256Hex(bytes),
  };
  const storedVisibility = opts?.visibility === "private" ? "private" : undefined;
  const storageMetadata: Record<string, string> = {
    ...provenance,
    // Only written when private — absence is the (majority) public default,
    // matching the historical shape of objects uploaded before this existed.
    ...(storedVisibility ? { [VISIBILITY_META_KEY]: storedVisibility } : {}),
  };

  try {
    await store.upload(finalKey, bytes, {
      contentType: inspection.contentType,
      cacheControl: UPLOAD_CACHE_CONTROL,
      metadata: storageMetadata,
    });
  } catch (err) {
    // Nothing was stored, so the reserved upload goes back to the budget.
    await releaseUploadsSafe(env.DB, workspaceName, 1);
    throw err;
  }

  // Usage accounting first: the object is already durably stored above, so
  // the ledger must be updated regardless of whether the metadata batch
  // below succeeds — otherwise a metadata failure leaves bytes/objects
  // stored but under-counted (recordUsageSafe never throws). The upload
  // itself was already counted by reserveUploads, hence `uploads: 0`.
  await recordUsageSafe(env.DB, workspaceName, {
    bytes: deltaBytes,
    objects: replaced ? 0 : 1,
    uploads: 0,
  });

  if (opts?.metadata) {
    // Full replace: an overwrite must not inherit a prior put's custom
    // metadata, so clear the row set before (re-)writing this request's, in
    // one atomic batch (replaceFileMetadata) rather than a delete followed
    // by a separate re-read-then-write.
    await replaceFileMetadata(env.DB, workspaceName, finalKey, opts.metadata);
  }

  const cfg = await storageConfig(env, ws);
  const urls = objectPublicUrls(env, cfg, finalKey);
  return {
    key: finalKey,
    url: urls.url,
    embedUrl: urls.embedUrl,
    size: newSize,
    contentType: inspection.contentType,
    replaced,
    metadata: provenance,
    ...(storedVisibility ? { visibility: storedVisibility } : {}),
  };
}

/**
 * Toggle an object's `visibility` custom-metadata flag. R2 custom metadata is
 * immutable in place, so this rewrites the object under the same key: a
 * `head` first (to enforce the same size cap as ordinary uploads, since the
 * rewrite buffers the whole body in memory) then a `download` + `upload` with
 * the toggled metadata. `contentType` and provenance metadata come straight
 * off the existing object; `cacheControl` is reapplied from
 * `UPLOAD_CACHE_CONTROL` (the same constant every upload already uses), so
 * this is a no-op for objects written by this API and a one-time
 * normalization for anything written before that constant existed.
 *
 * Throws `NotFoundError` when the object doesn't exist and `ValidationError`
 * (`code: "file_too_large"`) when it exceeds `maxBytes` — callers should let
 * both propagate to the route's error mapping.
 *
 * KNOWN RACE: the download→upload pair is not compare-and-swap — files-sdk
 * (2.1.0) exposes no conditional writes (etag/onlyIf), so an upload to the
 * same key that lands between the two steps is overwritten with this
 * request's older bytes (last-write-wins). Acceptable for now: toggles are
 * rare, member-initiated, and workspace-write-rate-limited. Revisit if
 * files-sdk grows conditional writes or a metadata-update API.
 */
export async function setObjectVisibility(
  store: Files,
  key: string,
  visibility: Visibility,
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<void> {
  const meta = await store.head(key).catch(() => null);
  if (!meta) throw new NotFoundError();
  if (meta.size > maxBytes) {
    throw new ValidationError("file too large to change visibility", {
      code: "file_too_large",
    });
  }

  const current = await store.download(key);
  const bytes = new Uint8Array(await current.arrayBuffer());
  const metadata: Record<string, string> = { ...current.metadata };
  if (visibility === "private") metadata[VISIBILITY_META_KEY] = "private";
  else delete metadata[VISIBILITY_META_KEY];

  await store.upload(key, bytes, {
    contentType: current.type,
    cacheControl: UPLOAD_CACHE_CONTROL,
    metadata,
  });
}

/** Non-ASCII-safe fallback for the `filename=` param (browsers that ignore `filename*`). */
function asciiFilenameFallback(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/** RFC 5987 `filename*=UTF-8''...` value for a Content-Disposition header. */
function encodeRfc5987Filename(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

/**
 * Stream a stored object as a forced-download `Response`. Shared by the
 * public file (`routes/public-files.ts`, behind `?download=1`) and public
 * gallery-item (`routes/public-galleries.ts`) download routes (design spec
 * §3.4) — bytes are proxied through this Worker specifically for the download
 * action (the inline-preview path keeps using the R2 custom domain directly,
 * unchanged). Full-file only: no `Range` support. Uses `StoredFile.stream()`
 * so the whole object is never buffered into Worker memory.
 */
export async function downloadResponse(
  store: Files,
  key: string,
  filename: string,
): Promise<Response> {
  const file = await store.download(key);
  const headers = new Headers();
  headers.set("Content-Type", file.type || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiFilenameFallback(filename)}"; ` +
      `filename*=UTF-8''${encodeRfc5987Filename(filename)}`,
  );
  if (typeof file.size === "number") headers.set("Content-Length", String(file.size));
  headers.set("Cache-Control", "no-store");
  return new Response(file.stream(), { headers });
}

/**
 * Provider object metadata → the JSON-safe `{ size, contentType, uploaded? }`
 * subset shared by HEAD and list responses. Normalizes the epoch `lastModified`
 * to an ISO `uploaded` and applies the fallback size/content type.
 */
function storedMetaJson(meta: { size?: number; type?: string; lastModified?: number }): {
  size: number;
  contentType: string;
  uploaded?: string;
} {
  return {
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
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
  embedUrl: string | null = null,
) {
  const provenance = provenanceForResponse(meta.metadata ?? undefined);
  const visibility = objectVisibility(meta.metadata ?? undefined);
  return {
    key,
    ...storedMetaJson(meta),
    url,
    embedUrl,
    ...(provenance ? { metadata: provenance } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

/** A listed object, normalized to the same field convention as `headObjectJson`. */
export interface ListedObject {
  key: string;
  url: string | null;
  embedUrl: string | null;
  size: number;
  contentType: string;
  /** ISO timestamp when the provider reports a last-modified time. */
  uploaded?: string;
  /** Present (== "private") only when the object was uploaded as private. */
  visibility?: "private";
  /**
   * D1 `gh.*`-style queryable metadata for this key (file-metadata.ts). Never
   * populated here — `listObjects` only projects storage-provider fields;
   * callers that want metadata hydrate it separately (e.g. via
   * `getMetadataForKeys`) and merge it onto each row.
   */
  metadata?: Record<string, string>;
}

export async function listObjects(
  env: Env,
  ws: WorkspaceRecord,
  opts: { prefix?: string; delimiter?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: ListedObject[]; cursor: string | null; prefixes?: string[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const store = await storage(env, ws);
  const result = await store.list({
    prefix: opts.prefix,
    delimiter: opts.delimiter,
    limit,
    cursor: opts.cursor,
  });
  const cfg = await storageConfig(env, ws);
  // files-sdk returns rich StoredFile items (size, type, lastModified); project
  // each to the shared HEAD/list subset (`storedMetaJson`) rather than spreading
  // the StoredFile, which carries reader methods and a raw epoch timestamp.
  return {
    items: result.items.map((item) => {
      const visibility = objectVisibility(item.metadata ?? undefined);
      const urls = objectPublicUrls(env, cfg, item.key);
      return {
        key: item.key,
        url: urls.url,
        embedUrl: urls.embedUrl,
        ...storedMetaJson(item),
        ...(visibility ? { visibility } : {}),
      };
    }),
    cursor: result.cursor ?? null,
    ...(result.prefixes ? { prefixes: result.prefixes } : {}),
  };
}

/** Delete an object (and its D1 custom metadata) and decrement the workspace ledger when size was known. */
export async function deleteObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  workspaceName: string,
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });

  const store = await storage(env, ws);
  const prev = await existingSize(store, key);

  await store.delete(key);
  await deleteFileMetadata(env.DB, workspaceName, key);

  if (prev !== null) {
    await recordUsageSafe(env.DB, workspaceName, {
      bytes: -prev,
      objects: -1,
      uploads: 0,
    });
  }

  return { key, deleted: true };
}
