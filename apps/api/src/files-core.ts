/**
 * Workspace file operations shared by the REST routes and the remote MCP
 * worker. Validation failures throw `@uploads/errors` AppErrors.
 */
import {
  ConflictError,
  NotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@uploads/errors";
import { createStorage, type Files, type StoredFile } from "@uploads/storage";
import { sanitizeFilename } from "@uploads/comment-render";
import { activeContentAllowed, activeContentAllowedForCopy } from "./active-content";
import { recordAdoptionSafe, type UploadSurface } from "./adoption";
import {
  budgetDenialError,
  checkPutBudget,
  enforcedMaxStorageBytes,
  enforcedStorageUsageBytes,
  resolveBudgetLimits,
  storageBudgetDenial,
  uploadBudgetDenial,
} from "./budget";
import {
  deleteFileMetadata,
  deleteServerFileMetadataKeys,
  mergeWithinMetadataCaps,
  replaceFileMetadata,
  CLASSIFIER_ROW_KEYS,
  setServerFileMetadata,
  validateMetadataEntries,
} from "./file-metadata";
import {
  applyInheritedMetaAdditively,
  contentHashForKey,
  deleteContentHashes,
  inheritableMetaForHash,
  recordContentHash,
} from "./content-hash";
import {
  type AttachmentSource,
  deleteAttachmentSafe,
  recordAttachmentForKeySafe,
} from "./github-attachment-index";
import { recordPrActivityFromMetadata } from "./github-pr-activity";
import { noteStorageFailure, noteStorageSuccess } from "./storage-health";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  detectContentType,
  detectImageDimensions,
  inspectUpload,
  isGatedContentType,
  resolveDeclaredContentType,
  resolveUploadPolicy,
  uploadKind,
} from "./guards";
import { checkKeyPolicy, resolveKeyPolicy } from "./key-policy";
import {
  decodeLaneCursor,
  decodeLaneResumeState,
  encodeLaneCursor,
  encodeLaneResumeState,
  LANE_DONE,
  mergeBounded,
} from "./lane-list";
import { pdfPreviewAllowed } from "./pdf-preview-gate";
import { getPdfPreviewRenderer } from "./pdf-preview-hook";
import {
  makePoster,
  mediabunnyProbe,
  mediaFrameExtractor,
  posterGenerationAllowed,
  posterKeyFor,
} from "./poster";
import {
  scheduleFileClassification,
  type ClassifierHandoff,
  type ClassifierWaitUntil,
} from "./classifier";

export type { ClassifierHandoff };
import { holdPolicyEnabled } from "./upload-hold";
import { deleteHeldCopy, heldBucket, reholdIfHeld } from "./held-storage";
import { deleteReadGateKeys, gateObjectKeysOnLane, hostedGateObjectKeys } from "./read-gate";
import {
  contentSha256Hex,
  provenanceForResponse,
  sanitizeProvenance,
  type ProvenanceMap,
} from "./provenance";
import {
  isSharedLane,
  objectPublicUrls,
  resolveObjectLane,
  storage,
  storageConfig,
  storageConfigs,
  type LaneConfig,
} from "./storage";
import {
  claimDeleteUsageSafe,
  clearDeleteUsageClaimSafe,
  getWorkspaceUsage,
  recordUsageSafe,
  releaseStorageBytesSafe,
  releaseUploadsSafe,
  reserveStorageBytes,
  reserveUploads,
} from "./usage";
import { objectVisibility, VISIBILITY_META_KEY, type Visibility } from "./visibility";
import { webOrigin } from "./web-url";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";
import { openStreamedBody, type StreamedBody } from "./streamed-body";
import { notifySlackHoldResolved } from "./slack-hold-notify";

export type { StreamedBody };

// Freshness floor on every write. GitHub embeds go through Camo, and max-age
// caps how long it serves a replaced image (R2's default was 4 hours).
export const UPLOAD_CACHE_CONTROL = "public, max-age=60";

/** Server-only first-upload stamp (Files SDK object metadata). Not client provenance. */
export {
  UPLOADED_AT_META_KEY,
  badKey,
  publicObjectDateFields,
  downloadResponse,
  downloadFilename,
  attachmentResponse,
} from "./files-read";
import { UPLOADED_AT_META_KEY, badKey } from "./files-read";

/**
 * Provenance key naming the storage lane an object was written to.
 * "lane_origin" marks uploads from before lanes existed. Nothing reads it
 * yet; it's a hook for future per-file routing or migration.
 */
export const STORAGE_LANE_META_KEY = "storage-lane";
const STORAGE_LANE_ORIGIN = "lane_origin";

/**
 * Managed GitHub-attachment keys live under `gh/` and re-upload the same key
 * so PR/issue embeds hot-swap. Every other key is strict: overwriting needs
 * `putObject`'s `replace`.
 */
export function isManagedGithubKey(key: string): boolean {
  return key === "gh" || key.startsWith("gh/");
}

/** Sanitize a bare basename for object keys — see `sanitizeFilename`. */
export function sanitizeKeyBasename(name: string): string {
  return sanitizeFilename(name);
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

/** Prior object head fields needed for metering + uploaded-at, or null if missing. */
async function existingHead(
  store: Files,
  key: string,
): Promise<{ size: number; lastModified?: number; metadata?: Record<string, string> } | null> {
  try {
    const meta = await store.head(key);
    return {
      size: meta.size ?? 0,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
    };
  } catch {
    return null;
  }
}

/** Size of an existing object, or `null` if missing / unreadable (metering may drift). */
async function existingSize(store: Files, key: string): Promise<number | null> {
  const head = await existingHead(store, key);
  return head?.size ?? null;
}

/**
 * Reserved keys a derived poster may write, cleared together on failure or
 * when the new bytes are a different kind. `pdf.*` is the first-page
 * preview; `video.*` is the frame extract.
 */
const DERIVED_POSTER_META_KEYS = [
  "video.poster",
  "video.duration",
  "video.width",
  "video.height",
  "pdf.poster",
  "pdf.pages",
  "pdf.width",
  "pdf.height",
];

/** Server-owned image dimensions, so the comment can size embeds without
 * fetching bytes. */
const IMAGE_META_KEYS = ["image.width", "image.height"];

/**
 * Best-effort `image.width`/`image.height`. Never throws; missing dims fall
 * back to the comment's filename heuristic. Always deletes first so a
 * replacement never keeps stale dims, and runs after `replaceFileMetadata`,
 * which would otherwise wipe these rows.
 */
async function storeImageDimensions(
  env: Env,
  workspaceName: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  try {
    await deleteServerFileMetadataKeys(dbFor(env), workspaceName, key, IMAGE_META_KEYS);
    if (uploadKind(contentType) !== "image") return;
    const dims = detectImageDimensions(bytes, contentType);
    if (!dims) return;
    await setServerFileMetadata(dbFor(env), workspaceName, key, {
      "image.width": String(dims.width),
      "image.height": String(dims.height),
    });
  } catch (err) {
    console.error({ event: "image_dimension_meta_failed", workspace: workspaceName, key, err });
  }
}

/** The MEDIA binding has no timeout of its own, so bound the poster wait. */
const POSTER_GENERATION_TIMEOUT_MS = 30_000;
/** PDFium render is in-isolate. Bound the upload wait; a sync raster past this still runs. */
const PDF_PREVIEW_TIMEOUT_MS = 10_000;

/**
 * Best-effort poster (video frame or PDF page 1). Never throws; the object
 * is already stored, and no poster keeps the comment's fallback.
 */
export async function generateAndStorePoster(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  workspaceName: string,
  visibility?: Visibility,
): Promise<void> {
  if (contentType === "application/pdf") {
    await generateAndStorePdfPreview(env, ws, key, bytes, workspaceName, visibility);
    return;
  }
  const posterKey = posterKeyFor(key);
  try {
    if (!(await posterGenerationAllowed(env, ws, workspaceName))) return;
    // posterGenerationAllowed already confirmed env.MEDIA is present; env.MEDIA
    // is typed optional so apps/mcp's Env (no media binding) also type-checks.
    if (!env.MEDIA) return;
    const made = await raceWithTimeout(
      makePoster(
        { bytes, contentType },
        { extractor: mediaFrameExtractor(env.MEDIA), probe: mediabunnyProbe() },
      ),
      POSTER_GENERATION_TIMEOUT_MS,
      "poster generation timed out",
    );
    if (!made) {
      await deleteStaleDerivedPoster(env, ws, workspaceName, key, posterKey);
      return;
    }
    await storeDerivedPoster(
      env,
      ws,
      workspaceName,
      key,
      posterKey,
      made.jpeg,
      made.meta,
      visibility,
    );
  } catch (err) {
    console.error({ event: "poster_generation_failed", workspace: workspaceName, key, err });
  }
}

/**
 * Best-effort first-page JPEG for a PDF. Same derived key and ledger rules
 * as a video poster. No renderer (the MCP worker) or a closed flag skips it.
 */
async function generateAndStorePdfPreview(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  bytes: Uint8Array,
  workspaceName: string,
  visibility?: Visibility,
): Promise<void> {
  const posterKey = posterKeyFor(key);
  try {
    const renderer = getPdfPreviewRenderer();
    // Before the limiter, so a worker that did not link PDFium spends nothing.
    if (!renderer) return;
    if (!(await pdfPreviewAllowed(env, ws, workspaceName))) return;
    const made = await raceWithTimeout(
      renderer(bytes),
      PDF_PREVIEW_TIMEOUT_MS,
      "pdf preview timed out",
    );
    if (!made) {
      // Inaccessible or skipped. Drop a previous still so the comment cannot
      // keep a JPEG for bytes we did not preview.
      await discardPdfPreview(env, ws, workspaceName, key, posterKey);
      return;
    }
    await storeDerivedPoster(
      env,
      ws,
      workspaceName,
      key,
      posterKey,
      made.jpeg,
      made.meta,
      visibility,
    );
  } catch (err) {
    // The PDF object is already stored. A throw here must not fail the put,
    // and must not leave a JPEG that the comment would treat as page 1.
    console.error({ event: "pdf_preview_failed", workspace: workspaceName, key, err });
    await discardPdfPreview(env, ws, workspaceName, key, posterKey);
  }
}

/** Best-effort. A cleanup failure is logged and swallowed. */
async function discardPdfPreview(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  posterKey: string,
): Promise<void> {
  try {
    await deleteStaleDerivedPoster(env, ws, workspaceName, key, posterKey);
  } catch (err) {
    console.error({ event: "pdf_preview_cleanup_failed", workspace: workspaceName, key, err });
  }
}

function raceWithTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** A replacement that can't be previewed must not keep the previous still. */
async function deleteStaleDerivedPoster(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  posterKey: string,
): Promise<void> {
  const store = await storage(env, ws);
  const stale = await existingSize(store, posterKey);
  if (stale === null) return;
  await store.delete(posterKey);
  await deleteServerFileMetadataKeys(dbFor(env), workspaceName, key, DERIVED_POSTER_META_KEYS);
  // Single-winner claim, same gate as deleteObject.
  if (await claimDeleteUsageSafe(dbFor(env), workspaceName, posterKey)) {
    await recordUsageSafe(
      dbFor(env),
      workspaceName,
      { bytes: -stale, objects: -1, uploads: 0 },
      undefined,
      { sharedLane: isSharedLane(ws) },
    );
  }
}

async function storeDerivedPoster(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  posterKey: string,
  jpeg: Uint8Array,
  meta: Record<string, string>,
  visibility?: Visibility,
): Promise<void> {
  const store = await storage(env, ws);
  const previous = await existingSize(store, posterKey);
  await store.upload(posterKey, jpeg, {
    contentType: "image/jpeg",
    cacheControl: UPLOAD_CACHE_CONTROL,
    // A private source must not leave a public still at the _internal/ path.
    ...(visibility === "private" ? { metadata: { [VISIBILITY_META_KEY]: "private" } } : {}),
  });
  // A re-created poster must be able to debit the ledger on a later delete.
  await clearDeleteUsageClaimSafe(dbFor(env), workspaceName, posterKey);
  // Counted because reconcileWorkspaceUsage walks every object under the prefix.
  await recordUsageSafe(
    dbFor(env),
    workspaceName,
    {
      bytes: jpeg.byteLength - (previous ?? 0),
      objects: previous === null ? 1 : 0,
      uploads: 0,
    },
    undefined,
    { sharedLane: isSharedLane(ws) },
  );
  // Full replace, not upsert: a regeneration that found fewer fields must not
  // leave stale video.* or pdf.* rows behind.
  await deleteServerFileMetadataKeys(dbFor(env), workspaceName, key, DERIVED_POSTER_META_KEYS);
  await setServerFileMetadata(dbFor(env), workspaceName, key, meta);
}

/**
 * Decide `uploaded-at` for a put. Create → now; overwrite → prior stamp, else
 * prior lastModified (legacy), else now. Never accepts a client-supplied value.
 */
export function resolveUploadedAtMeta(
  prior: { lastModified?: number; metadata?: Record<string, string> } | null,
  now: Date = new Date(),
): string {
  if (!prior) return now.toISOString();
  const stamped = prior.metadata?.[UPLOADED_AT_META_KEY];
  if (typeof stamped === "string" && Number.isFinite(Date.parse(stamped))) return stamped;
  if (prior.lastModified != null && Number.isFinite(prior.lastModified)) {
    return new Date(prior.lastModified).toISOString();
  }
  return now.toISOString();
}

/**
 * Put options that carry a stored object's provenance, visibility and
 * content type through a server-side copy (attach, promote, rotate), so the
 * destination admits it the same way the source did. The full `putObject`
 * path still runs. `serverCopy: true` only changes which active-content
 * verdicts admit a gated type: a copy within the same workspace doesn't
 * change exposure, so a stale freshness stamp must not make a stored SVG
 * uncopyable (that would wedge prefix rotation). Policy closes (workspace
 * opt-out, kill switch, unhealthy lane) still refuse.
 */
export function putOptsFromStoredObject(source: Pick<StoredFile, "metadata" | "type">): {
  provenance: Record<string, string> | undefined;
  visibility: Visibility | undefined;
  declaredContentType: string;
  serverCopy: true;
} {
  return {
    provenance: source.metadata,
    visibility: objectVisibility(source.metadata),
    declaredContentType: source.type,
    serverCopy: true as const,
  };
}

/**
 * Upload with the workspace's guardrails (size cap, content-type allowlist,
 * content type sniffed from the bytes; see guards.ts), then update the usage
 * ledger. Metering is best-effort and never fails the upload.
 */
export async function putObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  body: Uint8Array | StreamedBody,
  workspaceName: string,
  opts?: {
    provenance?: Record<string, string>;
    visibility?: Visibility;
    /**
     * Allow overwriting an existing object on a strict (non-`gh/`) key.
     * Otherwise such a put throws `ConflictError` (`key_exists`, with the
     * existing URLs in `details`). Always allowed on managed `gh/` paths.
     */
    replace?: boolean;
    /**
     * Queryable metadata (D1 `file_metadata`), distinct from the R2
     * provenance bag. When present (even `{}`) it replaces the object's
     * client metadata; undefined leaves existing rows untouched.
     */
    metadata?: Record<string, string>;
    /** Which entry point wrote this. Analytics Engine dimension only. */
    surface?: UploadSurface;
    /** Precomputed SHA-256 (hex) of `bytes`, to skip a second hash pass. */
    contentSha256?: string;
    /**
     * The client's claimed Content-Type, normalized. Only text types are
     * trusted, and only when sniffing finds nothing (see `inspectUpload`).
     * Omitted, the key's extension is the claim.
     */
    declaredContentType?: string;
    /**
     * Set by `putOptsFromStoredObject`: the bytes are already stored in this
     * workspace, so the gate asks `activeContentAllowedForCopy` instead (see
     * there). Only widens the allowlist; every other check still applies.
     */
    serverCopy?: boolean;
    /**
     * A pre-resolved `activeContentAllowed(env, ws)`, so a batch evaluates the
     * flag once. Only consulted for gated declared types, never for
     * `serverCopy`.
     */
    activeContent?: boolean;
    /**
     * Attribution for the attachment-index row, set by attach, promote and
     * adopt. Absent means `source: "put"` with the repo derived from the key.
     * `repo` must be server-resolved, never `gh.*` metadata (see
     * github-attachment-index.ts). A non-`"put"` source clears `detached_at`.
     */
    attachment?: { source: AttachmentSource; repo?: string };
    /**
     * Lets the classifier finish after the response. Absent (ingest,
     * server-side copies) skips classification.
     */
    waitUntil?: ClassifierWaitUntil;
    /**
     * The upload came from a client that can approve a hold
     * (`clientCanApprove`), so a flagged result holds the file. Otherwise a
     * would-be hold is only logged.
     */
    enforceHold?: boolean;
    /** Classify on another worker instead (`ClassifierHandoff`): the hosted MCP. */
    classifierHandoff?: ClassifierHandoff;
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
  /** `pending` when the classifier may still hold this file (`upload-hold.ts`). */
  holdCheck?: "pending";
  /**
   * The object's R2 provenance bag (`client`, `source-name`, `content-sha256`).
   * One bag, one name: `metadata` below always means the queryable tier.
   */
  provenance?: ProvenanceMap;
  /**
   * The queryable metadata this put stored, including server-derived pairs.
   * Omitted when the put carried no `metadata`, since existing rows were
   * left untouched and not read back.
   */
  metadata?: Record<string, string>;
  visibility?: Visibility;
}> {
  const finalKey = finalizeUploadKey(key, ws);
  // A streamed body (`streamed-body.ts`) is checked by its first bytes and
  // its declared size; `bytes` is only set for a buffered one.
  const bytes = body instanceof Uint8Array ? body : undefined;
  const newSize = bytes?.byteLength ?? (body as StreamedBody).size;
  if (newSize === 0) throw new ValidationError("empty body", { code: "empty_body" });

  // Validate before any write so a bad entry rejects the whole upload.
  if (opts?.metadata) validateMetadataEntries(opts.metadata);

  const declared = resolveDeclaredContentType(opts?.declaredContentType, finalKey);
  // The gate only decides whether gated SVG/XML rows are admitted, and those
  // are declared-only, so other claims skip the Flagship/KV lookup. A
  // server copy asks the copy-specific question.
  let activeContent = false;
  if (declared !== undefined && isGatedContentType(declared)) {
    activeContent =
      opts?.serverCopy === true
        ? await activeContentAllowedForCopy(env, ws)
        : (opts?.activeContent ?? (await activeContentAllowed(env, ws)));
  }
  const policy = resolveUploadPolicy(ws, { activeContent });
  const streamed = bytes ? undefined : await openStreamedBody(body as StreamedBody);
  const head = bytes ?? streamed!.head;
  // Text types are verified against the whole body (`inspectDeclared`), so
  // only types recognized from their magic bytes can stream.
  if (streamed && detectContentType(head) === null) {
    throw new UnsupportedMediaTypeError(
      "Files this large must be an image, video, PDF, or archive. Upload other types with the uploads CLI.",
      { code: "stream_type_unsupported" },
    );
  }
  const inspection = inspectUpload(head, policy, declared, newSize);
  if (!inspection.ok) throw inspection.error;

  const cfg = await storageConfig(env, ws);
  const store = createStorage(cfg);
  // files-sdk upload() has no replaced flag, so derive it from a head: the
  // ledger size delta and the prior stamp (overwrite keeps first upload).
  const prior = await existingHead(store, finalKey);
  const replaced = prior !== null;

  // Strict-overwrite gate, checked before any reservation or write.
  //
  // Known, accepted TOCTOU: two simultaneous first puts to the same new key
  // can both see `replaced === false`; the last R2 write wins and usage may
  // count both. Fixing it would need per-key serialization (a Durable
  // Object), which isn't worth it for a race that only exists before the
  // key does. Revisit only if it's observed.
  if (replaced && !opts?.replace && !isManagedGithubKey(finalKey)) {
    const urls = objectPublicUrls(env, cfg, finalKey);
    throw new ConflictError(
      `An object already exists at "${finalKey}". Pass --replace (or replace: true) to overwrite it.`,
      { code: "key_exists", details: { key: finalKey, url: urls.url, embedUrl: urls.embedUrl } },
    );
  }

  const deltaBytes = newSize - (prior?.size ?? 0);
  const uploadedAt = resolveUploadedAtMeta(prior);

  const usage = await getWorkspaceUsage(dbFor(env), workspaceName);
  // Cheap read-side reject for obviously spent budgets (both caps). Concurrent
  // puts at the boundary still need the atomic reservations below.
  const denial = checkPutBudget(usage, ws, { bytes: deltaBytes, uploads: 1 });
  if (denial) throw budgetDenialError(denial);

  // Atomically reserve the monthly upload count and (when growing) storage
  // bytes before the write. Reservations are the ledger increments, so
  // recordUsageSafe must not count them again; a failed write releases both.
  const { maxUploadsPerPeriod } = resolveBudgetLimits(ws);
  const maxStorageBytes = enforcedMaxStorageBytes(ws);
  const sharedLane = isSharedLane(ws);
  const uploadReservation = await reserveUploads(dbFor(env), workspaceName, 1, maxUploadsPerPeriod);
  if (!uploadReservation.ok) {
    throw budgetDenialError(
      uploadBudgetDenial(uploadReservation.usage, uploadReservation.maxUploadsPerPeriod),
    );
  }

  const storageReservation = await reserveStorageBytes(
    dbFor(env),
    workspaceName,
    deltaBytes,
    maxStorageBytes,
    undefined,
    { sharedLane },
  );
  if (!storageReservation.ok) {
    await releaseUploadsSafe(dbFor(env), workspaceName, 1);
    throw budgetDenialError(
      storageBudgetDenial(
        storageReservation.usage,
        storageReservation.maxStorageBytes,
        sharedLane ? storageReservation.deltaBytes : 0,
        // The fallback is unreachable today; kept so a contract change fails safe.
        enforcedStorageUsageBytes(ws, storageReservation.usage) ?? storageReservation.usage.bytes,
      ),
    );
  }
  const reservedBytes = storageReservation.reservedBytes;

  // Always hash the final stored body; never trust a client hash.
  // `uploaded-at` is server-only. A streamed body's hash is known only after
  // the write, so its `content-sha256` lives in the D1 hash index alone.
  let contentSha256 = bytes ? (opts?.contentSha256 ?? (await contentSha256Hex(bytes))) : undefined;
  // Started early so the D1 read overlaps the R2 write. Never rejects, so
  // it's safe to leave in flight if the upload throws.
  const inheritedPromise =
    contentSha256 === undefined
      ? undefined
      : inheritableMetaForHash(dbFor(env), workspaceName, contentSha256, finalKey);
  const provenance: ProvenanceMap = {
    ...sanitizeProvenance(opts?.provenance, { clientOnly: true }),
    ...(contentSha256 ? { "content-sha256": contentSha256 } : {}),
  };
  const storedVisibility = opts?.visibility === "private" ? "private" : undefined;
  const storageMetadata: Record<string, string> = {
    ...provenance,
    // Only written when private; absence means public.
    ...(storedVisibility ? { [VISIBILITY_META_KEY]: storedVisibility } : {}),
    [UPLOADED_AT_META_KEY]: uploadedAt,
    [STORAGE_LANE_META_KEY]: ws.storageLaneId ?? STORAGE_LANE_ORIGIN,
  };

  try {
    await store.upload(finalKey, bytes ?? streamed!.stream, {
      contentType: inspection.contentType,
      cacheControl: UPLOAD_CACHE_CONTROL,
      metadata: storageMetadata,
    });
  } catch (err) {
    // Settle the in-flight donor lookup so no D1 read outlives the request. It
    // resolves to `{}` rather than rejecting, so this only discards a result.
    await inheritedPromise;
    // Credential-shaped failures flag the BYO lane unhealthy so settings can
    // say so. Never throws.
    await noteStorageFailure(env, workspaceName, ws, err);
    // Nothing was stored — return both reservations to the budget.
    await releaseUploadsSafe(dbFor(env), workspaceName, 1);
    await releaseStorageBytesSafe(dbFor(env), workspaceName, reservedBytes, undefined, {
      sharedLane,
    });
    throw err;
  }

  contentSha256 ??= streamed!.sha256();

  // The write landed, so clear any unhealthy flag (no KV write when unset).
  await noteStorageSuccess(env, workspaceName, ws);

  // Post-write bookkeeping, all never-throwing and independent, so run
  // concurrently. The ledger must update even if the metadata batch below
  // fails. Upload count and reserved bytes were applied at reservation;
  // only the remaining deltas land here. Clearing the delete claim lets a
  // re-uploaded object debit the ledger on its next delete. Adoption metrics
  // count bytes written (`newSize`), not net change.
  await Promise.all([
    recordUsageSafe(
      dbFor(env),
      workspaceName,
      {
        bytes: reservedBytes > 0 ? 0 : deltaBytes,
        objects: replaced ? 0 : 1,
        uploads: 0,
      },
      undefined,
      { sharedLane },
    ),
    clearDeleteUsageClaimSafe(dbFor(env), workspaceName, finalKey),
    recordAdoptionSafe(env, {
      metric: "upload",
      workspace: workspaceName,
      bytes: newSize,
      dimensions: {
        surface: opts?.surface,
        contentType: inspection.contentType,
        client: provenance.client,
        repo: opts?.metadata?.["gh.repo"],
      },
    }),
    // Attachment index (see github-attachment-index.ts). Every putObject
    // caller passes through here. `lane_id` is the lane this write used.
    isManagedGithubKey(finalKey)
      ? recordAttachmentForKeySafe(dbFor(env), {
          workspace: workspaceName,
          objectKey: finalKey,
          source: opts?.attachment?.source ?? "put",
          laneId: ws.storageLaneId ?? null,
          repo: opts?.attachment?.repo,
          size: newSize,
          contentType: inspection.contentType,
        })
      : Promise.resolve(),
  ]);

  // Derived metadata from a content-identical earlier upload in this
  // workspace, for paths the CLI sidecar can't reach (hosted MCP, CI). Never
  // in the communal workspace; see inheritableMetaForHash.
  const inherited = await (inheritedPromise ??
    inheritableMetaForHash(dbFor(env), workspaceName, contentSha256, finalKey));

  // What actually landed in the queryable tier, echoed on the response.
  let storedMetadata: Record<string, string> | undefined;

  // Before recordContentHash overwrites the row. See CLASSIFIER_ROW_KEYS.
  const db = dbFor(env);
  const previousHash = await contentHashForKey(db, workspaceName, finalKey);
  const sameBytes = previousHash === contentSha256;
  if (!sameBytes) await deleteContentHashes(db, workspaceName, [finalKey]);

  if (opts?.metadata) {
    // Full replace in one batch: an overwrite must not inherit a prior put's
    // custom metadata. Classifier rows stay until the new hash is stored.
    storedMetadata = mergeWithinMetadataCaps(opts.metadata, inherited);
    await replaceFileMetadata(db, workspaceName, finalKey, storedMetadata, {
      keepClassifierRows: true,
    });
    // Explicit metadata only: inherited keys describe the bytes, and must not
    // attribute the donor upload's PR to this one.
    await recordPrActivityFromMetadata(db, workspaceName, opts.metadata);
  } else {
    // No metadata sent: leave existing tags alone and add inherited keys only.
    storedMetadata = await applyInheritedMetaAdditively(db, workspaceName, finalKey, inherited);
  }

  // Last and best-effort: a failed index write only costs later inheritance.
  await recordContentHash(db, workspaceName, finalKey, contentSha256);
  if (!sameBytes && (await contentHashForKey(db, workspaceName, finalKey)) === contentSha256) {
    await deleteServerFileMetadataKeys(db, workspaceName, finalKey, [...CLASSIFIER_ROW_KEYS]);
  }

  // After the metadata replace, never before: replaceFileMetadata deletes
  // client rows and would wipe the server-owned video.*/image.* rows.
  await storeImageDimensions(env, workspaceName, finalKey, head, inspection.contentType);
  // Posters and PDF previews need the whole file, so streamed bodies skip them.
  if (bytes) {
    await generateAndStorePoster(
      env,
      ws,
      finalKey,
      bytes,
      inspection.contentType,
      workspaceName,
      storedVisibility,
    );
  }

  // Held uploads (`held-storage.ts`). Identical bytes keep the hold, so this
  // object goes straight back out of the public bucket. New bytes end the
  // hold, so the old held copy is deleted, after the response when possible.
  const logHeldError = (err: unknown) =>
    console.error({ event: "held_put_sync_failed", workspace: workspaceName, err });
  if (sameBytes) {
    await reholdIfHeld(env, ws, workspaceName, finalKey).catch(logHeldError);
  } else {
    // New bytes are not the held object. Drop a gate row before classification
    // decides whether these bytes should be held.
    await deleteReadGateKeys(dbFor(env), gateObjectKeysOnLane(cfg, [finalKey])).catch(logHeldError);
  }
  if (!sameBytes && heldBucket(env)) {
    const cleanup = deleteHeldCopy(env, workspaceName, finalKey).catch(logHeldError);
    let deferred = false;
    try {
      if (opts?.waitUntil) {
        opts.waitUntil(cleanup);
        deferred = true;
      }
    } catch {
      // No execution context: finish the cleanup inline.
    }
    if (!deferred) await cleanup;
  }

  // Experimental: after storage and metadata, never on the critical path.
  // Fails open. Not for streamed bodies.
  const classifying =
    bytes !== undefined &&
    scheduleFileClassification(
      env,
      ws,
      workspaceName,
      finalKey,
      bytes,
      inspection.contentType,
      opts?.waitUntil,
      { enforceHold: opts?.enforceHold, handoff: opts?.classifierHandoff },
    );

  const urls = objectPublicUrls(env, cfg, finalKey);
  return {
    key: finalKey,
    url: urls.url,
    embedUrl: urls.embedUrl,
    size: newSize,
    contentType: inspection.contentType,
    replaced,
    provenance,
    ...(storedMetadata ? { metadata: storedMetadata } : {}),
    ...(storedVisibility ? { visibility: storedVisibility } : {}),
    // The classifier decides after this response; callers check `list_held`
    // or the PR comment.
    ...(classifying && opts?.enforceHold && holdPolicyEnabled(ws)
      ? { holdCheck: "pending" as const }
      : {}),
  };
}

/** The shape `putObject` resolves to — reused by the idempotency reconcile path below. */
export type PutObjectResult = Awaited<ReturnType<typeof putObject>>;

/**
 * Reconciles a `key_exists` on an idempotent `PUT` retry. A prior attempt
 * may have stored the bytes but crashed before its D1 work (metadata, hash
 * index, PR activity). When the stored `content-sha256` matches this retry,
 * re-drive `putObject` with `replace` so that work runs; the cost is a
 * one-off upload over-count.
 *
 * Returns `null` when there's no object, or its hash differs (a genuine
 * conflict, surfaced as `key_exists`).
 */
export async function reconcileInterruptedUpload(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  bytes: Uint8Array,
  expectedContentSha256: string,
  putOpts: NonNullable<Parameters<typeof putObject>[5]>,
): Promise<PutObjectResult | null> {
  const finalKey = finalizeUploadKey(key, ws);
  const lane = await resolveObjectLane(env, ws, finalKey);
  if (!lane) return null;

  const meta = await lane.store.head(finalKey).catch(() => null);
  if (!meta) return null;

  const provenance = provenanceForResponse(meta.metadata ?? undefined);
  if (provenance?.["content-sha256"] !== expectedContentSha256) return null;

  return putObject(env, ws, key, bytes, workspaceName, {
    ...putOpts,
    replace: true,
    contentSha256: expectedContentSha256,
  });
}

/**
 * Toggle an object's `visibility` flag. R2 custom metadata is immutable, so
 * this re-uploads under the same key, after a head to enforce the size cap
 * (the rewrite buffers the body). Throws `NotFoundError` or
 * `ValidationError` (`file_too_large`).
 *
 * Known race: download→upload isn't compare-and-swap (files-sdk has no
 * conditional writes), so a concurrent upload in between is overwritten.
 * Acceptable: toggles are rare and rate-limited.
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

  // The poster flips first, so a crash in between can never leave a private
  // video with a public poster frame.
  const posterKey = posterKeyFor(key);
  const posterExists = await store.head(posterKey).catch(() => null);
  if (posterExists) await rewriteVisibility(store, posterKey, visibility);

  await rewriteVisibility(store, key, visibility);
}

/** Download, flip `visibility`, re-upload. Shared by the object and its poster. */
async function rewriteVisibility(store: Files, key: string, visibility: Visibility): Promise<void> {
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

/**
 * Provider object metadata → the JSON-safe `{ size, contentType, uploaded? }`
 * subset shared by HEAD and list responses. Normalizes the epoch `lastModified`
 * to an ISO `uploaded` and applies the fallback size/content type.
 */
function storedMetaJson(meta: { size?: number; contentType?: string; lastModified?: number }): {
  size: number;
  contentType: string;
  uploaded?: string;
} {
  return {
    size: meta.size ?? 0,
    contentType: meta.contentType ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
  };
}

/**
 * HEAD/list metadata for API JSON. The queryable tier is a separate D1 read,
 * served by `?metadata=1` rather than costing every HEAD a query.
 */
export function headObjectJson(
  key: string,
  meta: {
    size?: number;
    contentType?: string;
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
    ...(provenance ? { provenance } : {}),
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
  /** Queryable metadata. Never populated by `listObjects`; callers hydrate it. */
  metadata?: Record<string, string>;
  /** Public `/f/` page URL, when `url` is set and the workspace has a slug. */
  pageUrl?: string;
}

/** Server-owned namespace (derived posters, CLI report uploads). Never listed. */
const INTERNAL_KEY_PREFIX = "_internal/";

export function filePageUrl(env: Env, workspace: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${webOrigin(env)}/f/${encodeURIComponent(workspace)}/${encodedKey}`;
}

/** A provider-list item shape, before projection to the API's `ListedObject`. */
interface RawListedItem {
  key: string;
  size?: number;
  contentType?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
}

/**
 * A key's public URLs in one lane, plus its `/f/` page when the object is
 * public and the workspace has a slug. Shared by the listing and by the
 * managed comment's index read, so both render the same links.
 */
export function objectLinks(
  env: Env,
  ws: WorkspaceRecord,
  cfg: Awaited<ReturnType<typeof storageConfig>>,
  key: string,
): { url: string | null; embedUrl: string | null; pageUrl?: string } {
  const urls = objectPublicUrls(env, cfg, key);
  return {
    url: urls.url,
    embedUrl: urls.embedUrl,
    ...(urls.url && ws.name ? { pageUrl: filePageUrl(env, ws.name, key) } : {}),
  };
}

/** HEAD/list projection, given which lane's config to derive URLs from. */
function projectListedObject(
  env: Env,
  ws: WorkspaceRecord,
  cfg: Awaited<ReturnType<typeof storageConfig>>,
  item: RawListedItem,
): ListedObject {
  const visibility = objectVisibility(item.metadata ?? undefined);
  const { url, embedUrl, pageUrl } = objectLinks(env, ws, cfg, item.key);
  return {
    key: item.key,
    url,
    embedUrl,
    ...storedMetaJson(item),
    ...(visibility ? { visibility } : {}),
    ...(pageUrl ? { pageUrl } : {}),
  };
}

/** One lane's fetched batch, with enough state to resume it next page. */
interface LaneFetch {
  laneKeyStr: string;
  cfg: Awaited<ReturnType<typeof storageConfig>>;
  /** Items after the cursor's high-water key. Empty without fetching when the lane was done. */
  remaining: RawListedItem[];
  /** The provider cursor this fetch used, reused if `remaining` isn't consumed. */
  providerCursorUsed: string | undefined;
  /** The provider's own next-cursor for this batch, if it was truncated. */
  providerNextCursor: string | undefined;
  /** The lane was already `LANE_DONE`; no fetch was made. */
  wasDone: boolean;
}

const ACTIVE_LANE_CURSOR_KEY = "active";

export async function listObjects(
  env: Env,
  ws: WorkspaceRecord,
  opts: {
    prefix?: string;
    delimiter?: string;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: ListedObject[]; cursor: string | null; prefixes?: string[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const configs = await storageConfigs(env, ws);

  if (configs.length === 1) {
    // Single lane: one provider call with the raw provider cursor.
    const cfg = configs[0].config;
    const store = createStorage(cfg);
    const result = await store.list({
      prefix: opts.prefix,
      delimiter: opts.delimiter,
      limit,
      cursor: opts.cursor,
    });
    return {
      // Server-owned artifacts are never rows. `limit` applies before this
      // filter, so a short page can still have a cursor; follow the cursor.
      items: result.items
        .filter((item) => !item.key.startsWith(INTERNAL_KEY_PREFIX))
        .map((item) => projectListedObject(env, ws, cfg, item)),
      cursor: result.cursor ?? null,
      ...(result.prefixes ? { prefixes: result.prefixes } : {}),
    };
  }

  // Multi-lane fan-out + merge. A garbage or pre-lanes cursor starts fresh.
  const cursorMap = decodeLaneCursor(opts.cursor) ?? { v: 1, lanes: {} };
  // Nothing at or before the high-water key is re-emitted, as a backstop to
  // `LANE_DONE`.
  const highWater = cursorMap.after;
  const laneCursorKey = (laneId: string | null) => laneId ?? ACTIVE_LANE_CURSOR_KEY;

  const prefixesSeen: string[] = [];
  const fetches: LaneFetch[] = await Promise.all(
    configs.map(async (lc): Promise<LaneFetch> => {
      const laneKeyStr = laneCursorKey(lc.laneId);
      const { cursor: providerCursor, done } = decodeLaneResumeState(cursorMap.lanes[laneKeyStr]);
      if (done) {
        return {
          laneKeyStr,
          cfg: lc.config,
          remaining: [],
          providerCursorUsed: undefined,
          providerNextCursor: undefined,
          wasDone: true,
        };
      }
      const store = createStorage(lc.config);
      const result = await store.list({
        prefix: opts.prefix,
        delimiter: opts.delimiter,
        limit,
        cursor: providerCursor,
      });
      for (const p of result.prefixes ?? []) if (!prefixesSeen.includes(p)) prefixesSeen.push(p);
      const remaining = result.items
        .filter((item) => !item.key.startsWith(INTERNAL_KEY_PREFIX))
        .filter((item) => highWater === undefined || item.key > highWater);
      return {
        laneKeyStr,
        cfg: lc.config,
        remaining,
        providerCursorUsed: providerCursor,
        providerNextCursor: result.cursor,
        wasDone: false,
      };
    }),
  );

  // Tag items with their lane config so the merge result can be projected per
  // lane. `fetches` is active-first, the merge priority order.
  const taggedPages = fetches.map((fetch) => ({
    items: fetch.remaining.map((raw) => ({ ...raw, __cfg: fetch.cfg })),
  }));
  const merged = mergeBounded(taggedPages, limit);

  const nextLanes: Record<string, string> = {};
  fetches.forEach((fetch, i) => {
    if (fetch.wasDone) {
      nextLanes[fetch.laneKeyStr] = LANE_DONE;
      return;
    }
    const consumedCount = merged.consumed[i] ?? 0;
    const fullyConsumed = consumedCount >= fetch.remaining.length;
    if (fullyConsumed && !fetch.providerNextCursor) {
      // Mark done explicitly so "no entry" never reads as "not started".
      nextLanes[fetch.laneKeyStr] = LANE_DONE;
    } else if (fullyConsumed) {
      // Batch fully spent, but the provider says there's more — advance.
      nextLanes[fetch.laneKeyStr] = encodeLaneResumeState(fetch.providerNextCursor);
    } else {
      // Trimmed mid-batch: re-fetch the same cursor; `highWater` drops repeats.
      nextLanes[fetch.laneKeyStr] = encodeLaneResumeState(fetch.providerCursorUsed);
    }
  });

  const lastEmittedKey = merged.items.at(-1)?.key;
  const nextHighWater = lastEmittedKey ?? highWater;
  const allDone = Object.values(nextLanes).every((v) => v === LANE_DONE);

  return {
    items: merged.items.map((raw) => projectListedObject(env, ws, raw.__cfg, raw)),
    cursor: allDone
      ? null
      : encodeLaneCursor({
          v: 1,
          lanes: nextLanes,
          ...(nextHighWater !== undefined ? { after: nextHighWater } : {}),
        }),
    ...(prefixesSeen.length > 0 ? { prefixes: prefixesSeen } : {}),
  };
}

/** One lane a delete removed the object from: its size and whether the lane is platform-owned. */
interface DeletedLaneHit {
  size: number;
  sharedLane: boolean;
}

/**
 * Delete `key` from every lane that holds it (a key can exist in several
 * after a detach/re-attach). Uses `allSettled` so one lane's failure doesn't
 * hide another's success: `hits` are completed deletes, safe to debit;
 * `failures` are surfaced by the caller after crediting. A retry can't
 * double-debit, since the key is already gone from those lanes.
 */
async function deleteFromEveryLane(
  configs: LaneConfig[],
  key: string,
): Promise<{ hits: DeletedLaneHit[]; failures: unknown[] }> {
  const targets = configs.map((lc) => ({
    store: createStorage(lc.config),
    sharedLane: isSharedLane(lc.config),
  }));
  const sizes = await Promise.all(targets.map((t) => existingSize(t.store, key)));
  const present = targets
    .map((t, i) => ({ ...t, size: sizes[i] }))
    .filter((t): t is typeof t & { size: number } => t.size !== null);

  const settled = await Promise.allSettled(present.map((t) => t.store.delete(key)));
  const hits: DeletedLaneHit[] = [];
  const failures: unknown[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      hits.push({ size: present[i]!.size, sharedLane: present[i]!.sharedLane });
    } else {
      failures.push(result.reason);
    }
  });
  return { hits, failures };
}

/** Debits the ledger for each lane a delete removed the object from. */
async function recordDeletedLaneUsage(
  env: Env,
  workspaceName: string,
  hits: DeletedLaneHit[],
): Promise<void> {
  await Promise.all(
    hits.map((hit) =>
      recordUsageSafe(
        dbFor(env),
        workspaceName,
        { bytes: -hit.size, objects: -1, uploads: 0 },
        undefined,
        { sharedLane: hit.sharedLane },
      ),
    ),
  );
}

/** Delete an object (and its D1 custom metadata) and decrement the workspace ledger when size was known. */
export async function deleteObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  workspaceName: string,
  opts?: {
    /**
     * Private-prefix rotation already rekeyed this key's attachment-index
     * row, so skip deleting it. Never set from a request.
     */
    skipAttachmentIndex?: boolean;
  },
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });

  // Resolve while the object is still in a lane. A later delete cannot.
  const gateKeys = await hostedGateObjectKeys(env, ws, [key]);
  const configs = await storageConfigs(env, ws);
  const { hits, failures } = await deleteFromEveryLane(configs, key);
  // A held upload's bytes may be in the held bucket. Its size still counts.
  const heldSize = await deleteHeldCopy(env, workspaceName, key, {
    measure: hits.length === 0,
  }).catch((err: unknown) => {
    console.error({ event: "held_delete_failed", workspace: workspaceName, err });
    return null;
  });
  if (heldSize !== null) hits.push({ size: heldSize, sharedLane: true });
  await deleteFileMetadata(dbFor(env), workspaceName, key);
  await deleteContentHashes(dbFor(env), workspaceName, [key]);
  await deleteReadGateKeys(dbFor(env), gateKeys);
  // A held file going away ends its hold: rewrite the Slack DMs about it.
  if (heldSize !== null) await notifySlackHoldResolved(env, workspaceName, key, "deleted");

  if (hits.length > 0) {
    // Concurrent DELETEs can both get here; only the first claimer debits the
    // ledger. Claim after the storage delete so a failed delete keeps the slot.
    const wonClaim = await claimDeleteUsageSafe(dbFor(env), workspaceName, key);
    if (wonClaim) {
      // Positive bytes under `delete`, never negative under `upload`.
      const deletedBytes = hits.reduce((sum, hit) => sum + hit.size, 0);
      await Promise.all([
        recordDeletedLaneUsage(env, workspaceName, hits),
        recordAdoptionSafe(env, {
          metric: "delete",
          workspace: workspaceName,
          bytes: deletedBytes,
        }),
      ]);
    }
  }
  // Fail only after crediting every successful lane.
  if (failures.length > 0) throw failures[0];

  // Remove the attachment-index row only once every lane's delete succeeded,
  // or a surviving copy drops out of the managed comment.
  if (!opts?.skipAttachmentIndex) await deleteAttachmentSafe(dbFor(env), workspaceName, key);

  // Best-effort poster cleanup from every lane; never fails the delete.
  const posterKey = posterKeyFor(key);
  try {
    const { hits: posterHits, failures: posterFailures } = await deleteFromEveryLane(
      configs,
      posterKey,
    );
    if (posterHits.length > 0) {
      if (await claimDeleteUsageSafe(dbFor(env), workspaceName, posterKey)) {
        await recordDeletedLaneUsage(env, workspaceName, posterHits);
      }
    }
    if (posterFailures.length > 0) throw posterFailures[0];
  } catch (err) {
    console.error({ event: "poster_delete_failed", workspace: workspaceName, key, err });
  }

  return { key, deleted: true };
}
