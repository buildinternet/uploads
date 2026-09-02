/**
 * Workspace file operations shared by the REST routes (routes/files.ts) and
 * the remote MCP worker (apps/mcp) — one code path for key/body validation,
 * storage I/O, and result shapes. Validation failures throw AppError subclasses
 * from `@uploads/errors`; REST serializes via `respondError`, MCP surfaces
 * `message` in the tool error.
 */
import { ConflictError, NotFoundError, ValidationError } from "@uploads/errors";
import { createStorage, type Files, type StoredFile } from "@uploads/storage";
import { activeContentAllowed } from "./active-content";
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
  setServerFileMetadata,
  validateMetadataEntries,
} from "./file-metadata";
import {
  applyInheritedMetaAdditively,
  inheritableMetaForHash,
  recordContentHash,
} from "./content-hash";
import { recordPrActivityFromMetadata } from "./github-pr-activity";
import { noteStorageFailure, noteStorageSuccess } from "./storage-health";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  detectImageDimensions,
  inspectUpload,
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
import {
  makePoster,
  mediabunnyProbe,
  mediaFrameExtractor,
  posterGenerationAllowed,
  posterKeyFor,
} from "./poster";
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

// The freshness floor on overwrite for every bucket. This is the operative lever
// for GitHub embeds: they're proxied through GitHub's Camo/Fastly cache, and
// max-age caps how long Camo serves a stale copy before revalidating against the
// (now-overwritten) origin. Without it, R2's custom-domain default (max-age=14400)
// kept replaced images stale for hours.
export const UPLOAD_CACHE_CONTROL = "public, max-age=60";

/** Server-only first-upload stamp (Files SDK object metadata). Not client provenance. */
export const UPLOADED_AT_META_KEY = "uploaded-at";

/**
 * Server-only provenance key naming which storage lane this object was
 * written to (two-lane storage). "lane_origin" marks an upload made before
 * `WorkspaceRecord.storageLaneId` existed. Zero read-path dependency today —
 * resolution stays fallback-based (`resolveObjectLane`) — this is a cheap
 * forward hook for future per-file routing/migration tooling (#630/#594).
 */
export const STORAGE_LANE_META_KEY = "storage-lane";
const STORAGE_LANE_ORIGIN = "lane_origin";

const KEY_RE = /^[\w!*'()./-]+$/;

/**
 * Managed GitHub-attachment paths (`attach`, `put --pr`/`--issue`, and the
 * branch-staging fallback) always live under the `gh/` root and re-upload the
 * same key on purpose so PR/issue embeds hot-swap — see issue #174. Every
 * other key (explicit `--key`, bare `put`) is a "strict" path: overwriting an
 * existing object there requires an explicit opt-in (see `putObject`'s
 * `replace` option).
 */
export function isManagedGithubKey(key: string): boolean {
  return key === "gh" || key.startsWith("gh/");
}

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

/** Reserved keys `makePoster` may write, cleared together when it fails. */
const POSTER_META_KEYS = ["video.poster", "video.duration", "video.width", "video.height"];

/** Server-owned pixel-dimension rows for an image, written at upload time so
 * the managed comment can size embeds without re-fetching bytes (issue #365
 * follow-up). Cleared together, mirroring `POSTER_META_KEYS`. */
const IMAGE_META_KEYS = ["image.width", "image.height"];

/**
 * Best-effort `image.width`/`image.height` derived metadata. Never throws:
 * the object is durably stored by the time this runs, and missing dims simply
 * mean the comment renderer falls back to its filename heuristic.
 *
 * Delete-first always, for every content type: an image replaced by a
 * non-image (or by an image whose header can't be parsed) must not keep the
 * prior upload's stale dimensions. Runs after `replaceFileMetadata` for the
 * same reason `generateAndStorePoster` does — replace is delete-then-insert
 * and would wipe these server-owned rows.
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

/**
 * Upper bound on frame extraction (issue #299 review): the MEDIA binding
 * exposes no AbortSignal/timeout hook of its own (confirmed against
 * Cloudflare's docs — see the coderabbit finding), so `makePoster`'s call
 * into it could otherwise hang indefinitely and hold `putObject`'s response
 * open. This race just bounds that wait; the outer try/catch below already
 * turns a rejection into the ordinary no-poster path.
 */
const POSTER_GENERATION_TIMEOUT_MS = 30_000;

/**
 * Best-effort poster generation (issue #299). Never throws: the object is
 * already durably stored by the time this runs, and no poster simply means the
 * managed comment renders a bullet link, exactly as it did before this feature.
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
  const posterKey = posterKeyFor(key);
  try {
    if (!(await posterGenerationAllowed(env, ws, workspaceName))) return;
    // posterGenerationAllowed already confirmed env.MEDIA is present; env.MEDIA
    // is typed optional so apps/mcp's Env (no media binding) also type-checks.
    if (!env.MEDIA) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const made = await Promise.race([
      makePoster(
        { bytes, contentType },
        { extractor: mediaFrameExtractor(env.MEDIA), probe: mediabunnyProbe() },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("poster generation timed out")),
          POSTER_GENERATION_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      // Never keep the worker alive on the timer once either side settles.
      if (timer !== undefined) clearTimeout(timer);
    });

    const store = await storage(env, ws);
    if (!made) {
      // A replacement that can't be postered must not keep the old frame.
      const stale = await existingSize(store, posterKey);
      if (stale !== null) {
        await store.delete(posterKey);
        await deleteServerFileMetadataKeys(dbFor(env), workspaceName, key, POSTER_META_KEYS);
        // Single-winner claim (issue #570) — same gate as deleteObject.
        if (await claimDeleteUsageSafe(dbFor(env), workspaceName, posterKey)) {
          await recordUsageSafe(
            dbFor(env),
            workspaceName,
            {
              bytes: -stale,
              objects: -1,
              uploads: 0,
            },
            undefined,
            { sharedLane: isSharedLane(ws) },
          );
        }
      }
      return;
    }

    const previous = await existingSize(store, posterKey);
    await store.upload(posterKey, made.jpeg, {
      contentType: "image/jpeg",
      cacheControl: UPLOAD_CACHE_CONTROL,
      // Mirrors putObject's own VISIBILITY_META_KEY convention: only written
      // when private, so a private source video never leaves behind a
      // publicly-fetchable poster at its deterministic _internal/ path.
      ...(visibility === "private" ? { metadata: { [VISIBILITY_META_KEY]: "private" } } : {}),
    });
    // A re-created poster must be able to debit the ledger on a later delete.
    await clearDeleteUsageClaimSafe(dbFor(env), workspaceName, posterKey);
    // Counted because reconcileWorkspaceUsage walks every object under the
    // prefix and would otherwise disagree with the ledger permanently.
    await recordUsageSafe(
      dbFor(env),
      workspaceName,
      {
        bytes: made.jpeg.byteLength - (previous ?? 0),
        objects: previous === null ? 1 : 0,
        uploads: 0,
      },
      undefined,
      { sharedLane: isSharedLane(ws) },
    );
    // Full replace, not upsert: a regeneration whose probe/extraction found
    // fewer fields than the prior poster (e.g. no dims this time) must not
    // leave stale video.width/height/duration rows behind.
    await deleteServerFileMetadataKeys(dbFor(env), workspaceName, key, POSTER_META_KEYS);
    await setServerFileMetadata(dbFor(env), workspaceName, key, made.meta);
  } catch (err) {
    console.error({ event: "poster_generation_failed", workspace: workspaceName, key, err });
  }
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

/** Same-second tolerance so storage noise does not force dual public date fields. */
const PUBLIC_DATE_EQUAL_MS = 1000;

/**
 * Public share/gallery date fields from a Files SDK head.
 * Prefer `uploaded-at` stamp; fall back to provider `lastModified`.
 * Emit `modified` only when mtime meaningfully differs (fresh put → single field).
 */
export function publicObjectDateFields(meta: {
  lastModified?: number;
  metadata?: Record<string, string>;
}): { uploaded?: string; modified?: string } {
  const modifiedIso =
    meta.lastModified != null && Number.isFinite(meta.lastModified)
      ? new Date(meta.lastModified).toISOString()
      : undefined;
  const stamped = meta.metadata?.[UPLOADED_AT_META_KEY];
  const uploadedIso =
    typeof stamped === "string" && Number.isFinite(Date.parse(stamped))
      ? new Date(stamped).toISOString()
      : modifiedIso;

  if (!uploadedIso) return {};
  if (
    !modifiedIso ||
    Math.abs(Date.parse(modifiedIso) - Date.parse(uploadedIso)) < PUBLIC_DATE_EQUAL_MS
  ) {
    return { uploaded: uploadedIso };
  }
  return { uploaded: uploadedIso, modified: modifiedIso };
}

/**
 * Put options that carry a stored object's own attributes through a
 * server-side copy (attach, promote, rotate): its provenance bag, the
 * visibility that bag encodes, and its stored content type as the declared
 * claim, so a text object under an extension-less key is admitted by
 * `inspectUpload` at the destination the same way it was at the source.
 * Every copy still runs the full `putObject` write path — nothing here
 * bypasses inspection.
 */
export function putOptsFromStoredObject(source: Pick<StoredFile, "metadata" | "type">): {
  provenance: Record<string, string> | undefined;
  visibility: Visibility | undefined;
  declaredContentType: string;
} {
  return {
    provenance: source.metadata,
    visibility: objectVisibility(source.metadata),
    declaredContentType: source.type,
  };
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
     * Allow overwriting an existing object on a "strict" (non-`gh/`) key —
     * see `isManagedGithubKey`. Ignored (always allowed) on managed `gh/`
     * paths, which stay silent hot-swap. Defaults to false: a strict-path put
     * that would overwrite an existing object throws `ConflictError`
     * (`code: "key_exists"`, `details.url`/`details.embedUrl` naming the
     * existing object) instead of writing. Callers opt in per-request
     * (CLI `--replace`, or `UPLOADS_OVERWRITE=1` as a CLI-side default) —
     * there is no server-side global escape hatch.
     */
    replace?: boolean;
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
    /**
     * Which server-side entry point is writing this object. Recorded as an
     * Analytics Engine dimension only — never stored in D1, never affects the
     * write. Absent means the caller predates this parameter.
     */
    surface?: UploadSurface;
    /**
     * Precomputed SHA-256 (hex) of `bytes`. The idempotent-PUT path already
     * hashes the body for its fingerprint; passing it here avoids a second pass
     * over a potentially multi-MB body. Omit to hash internally as usual.
     */
    contentSha256?: string;
    /**
     * The client's claimed Content-Type (already normalized to type/subtype)
     * or undefined. Only text types are ever trusted, and only when sniffing
     * finds nothing — see `inspectUpload`. When omitted, the key's extension
     * is the claim, which is what the hosted MCP and older CLIs rely on.
     */
    declaredContentType?: string;
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
  /**
   * The object's R2 provenance bag (`client`, `source-name`, `content-sha256`).
   * One bag, one name: `metadata` below always means the queryable tier.
   */
  provenance?: ProvenanceMap;
  /**
   * The queryable metadata (D1 `file_metadata`) this put stored, including any
   * server-derived pairs the caller did not send (`gh.uploader`). Omitted —
   * not empty — when the put carried no `metadata` at all, since that case
   * leaves whatever rows already existed untouched and reads nothing back.
   */
  metadata?: Record<string, string>;
  visibility?: Visibility;
}> {
  const finalKey = finalizeUploadKey(key, ws);
  if (bytes.byteLength === 0) throw new ValidationError("empty body", { code: "empty_body" });

  // Validate custom metadata before any write so a bad key/value or a
  // cap breach rejects the whole upload instead of landing bytes first.
  if (opts?.metadata) validateMetadataEntries(opts.metadata);

  const declared = resolveDeclaredContentType(opts?.declaredContentType, finalKey);
  const policy = resolveUploadPolicy(ws, { activeContent: await activeContentAllowed(env, ws) });
  const inspection = inspectUpload(bytes, policy, declared);
  if (!inspection.ok) throw inspection.error;

  const store = await storage(env, ws);
  // Pre-upload head: ledger size delta + prior stamp/mtime (overwrite keeps first upload).
  // files-sdk upload() has no replaced/exists flag, so we derive it here.
  const prior = await existingHead(store, finalKey);
  const replaced = prior !== null;

  // Strict-overwrite gate (issue #174): managed `gh/` paths always hot-swap;
  // every other key refuses an overwrite unless the caller opted in via
  // `opts.replace`. Checked before any budget reservation or write so a
  // refusal never touches usage accounting.
  //
  // Known TOCTOU, accepted deliberately: `existingHead` above and the R2
  // write below are two separate calls, not one atomic operation, so two
  // concurrent first-puts to the same never-before-seen `finalKey` can both
  // observe `replaced === false` and both proceed as "creates" — each gets
  // its own upload-count reservation (see `reserveUploads` below), and
  // whichever R2 write lands last silently wins, same as the other's bytes
  // being clobbered. True cross-request atomicity per key would need a
  // Durable Object (or a D1-backed claim table with its own cleanup/TTL
  // story for crashed claims) serializing every put — disproportionate
  // infrastructure for a race that only bites two truly simultaneous first
  // writes to the *same* key, and whose worst case is exactly the
  // pre-#174 behavior (silent overwrite, last-write-wins) for that narrow
  // window — not a new failure mode, not a security regression, and not
  // reachable at all once the key exists (the second writer's read then
  // correctly observes `replaced === true`). Usage accounting can double-count
  // the upload delta for that one race (two reservations for one surviving
  // object); left unmitigated as the same order-of-magnitude inaccuracy
  // budget checks already tolerate at their cap boundary (see the comment
  // on `reserveUploads` below). Revisit only if this key-collision race is
  // ever observed in practice, not preemptively.
  if (replaced && !opts?.replace && !isManagedGithubKey(finalKey)) {
    const cfg = await storageConfig(env, ws);
    const urls = objectPublicUrls(env, cfg, finalKey);
    throw new ConflictError(
      `An object already exists at "${finalKey}". Pass --replace (or replace: true) to overwrite it.`,
      { code: "key_exists", details: { key: finalKey, url: urls.url, embedUrl: urls.embedUrl } },
    );
  }

  const newSize = bytes.byteLength;
  const deltaBytes = newSize - (prior?.size ?? 0);
  const uploadedAt = resolveUploadedAtMeta(prior);

  const usage = await getWorkspaceUsage(dbFor(env), workspaceName);
  // Cheap read-side reject for obviously spent budgets (both caps). Concurrent
  // puts at the boundary still need the atomic reservations below.
  const denial = checkPutBudget(usage, ws, { bytes: deltaBytes, uploads: 1 });
  if (denial) throw budgetDenialError(denial);

  // Atomically reserve monthly upload count AND (when growing) net storage
  // bytes before the R2 write. Reservations ARE the ledger increments for
  // those fields, so post-put recordUsageSafe must not count them again; a
  // failed write releases both.
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
        // The `?? .bytes` fallback is unreachable by construction, not a
        // real degrade path: `reserveStorageBytes` only ever returns
        // `ok: false` when `maxStorageBytes` (== `enforcedMaxStorageBytes(ws)`
        // here) is defined, and that is `enforcedStorageUsageBytes`'s only
        // undefined-condition — so this call can never actually see
        // `undefined`. Kept rather than asserted non-null so a future change
        // to either function's contract fails safe instead of throwing.
        enforcedStorageUsageBytes(ws, storageReservation.usage) ?? storageReservation.usage.bytes,
      ),
    );
  }
  const reservedBytes = storageReservation.reservedBytes;

  // Client headers first; always attach content-sha256 of the final stored body
  // (never trust a client-supplied hash). Visibility lives alongside provenance
  // in the same custom-metadata bag but is tracked separately (not client-free-form).
  // `uploaded-at` is server-only — set on the final bag, never via sanitizeProvenance.
  const contentSha256 = opts?.contentSha256 ?? (await contentSha256Hex(bytes));
  // Started here rather than where it is consumed, so this D1 read overlaps the
  // R2 write and usage accounting instead of adding its latency after them. Safe
  // to leave in flight: inheritableMetaForHash never rejects (it resolves to `{}`
  // on any failure), so an upload that throws below cannot orphan a rejection.
  const inheritedPromise = inheritableMetaForHash(
    dbFor(env),
    workspaceName,
    contentSha256,
    finalKey,
  );
  const provenance: ProvenanceMap = {
    ...sanitizeProvenance(opts?.provenance, { clientOnly: true }),
    "content-sha256": contentSha256,
  };
  const storedVisibility = opts?.visibility === "private" ? "private" : undefined;
  const storageMetadata: Record<string, string> = {
    ...provenance,
    // Only written when private — absence is the (majority) public default,
    // matching the historical shape of objects uploaded before this existed.
    ...(storedVisibility ? { [VISIBILITY_META_KEY]: storedVisibility } : {}),
    [UPLOADED_AT_META_KEY]: uploadedAt,
    [STORAGE_LANE_META_KEY]: ws.storageLaneId ?? STORAGE_LANE_ORIGIN,
  };

  try {
    await store.upload(finalKey, bytes, {
      contentType: inspection.contentType,
      cacheControl: UPLOAD_CACHE_CONTROL,
      metadata: storageMetadata,
    });
  } catch (err) {
    // Settle the in-flight donor lookup so no D1 read outlives the request. It
    // resolves to `{}` rather than rejecting, so this only discards a result.
    await inheritedPromise;
    // Credential-shaped failures flag the active BYO lane unhealthy (issue
    // #826) so the settings page and the signed-in banner can say so before
    // the next person notices a broken upload. Filters non-credential
    // failures and shared lanes itself, and never throws.
    await noteStorageFailure(env, workspaceName, ws, err);
    // Nothing was stored — return both reservations to the budget.
    await releaseUploadsSafe(dbFor(env), workspaceName, 1);
    await releaseStorageBytesSafe(dbFor(env), workspaceName, reservedBytes, undefined, {
      sharedLane,
    });
    throw err;
  }

  // The write landed, so whatever flagged this lane unhealthy is over —
  // clear it (issue #826). Returns without touching KV when nothing is
  // flagged, which is every upload on a working workspace.
  await noteStorageSuccess(env, workspaceName, ws);

  // Usage accounting first: the object is already durably stored above, so
  // the ledger must be updated regardless of whether the metadata batch
  // below succeeds — otherwise a metadata failure leaves bytes/objects
  // stored but under-counted (recordUsageSafe never throws). Upload count
  // and any reserved positive byte delta were already applied at reservation
  // time; only remaining deltas (objects; shrink/unlimited bytes) land here.
  //
  // Clear any prior delete-usage claim for this key (issue #570) so a
  // re-uploaded object can debit the ledger on its next delete. Runs with
  // the other post-write bookkeeping below.
  //
  // Adoption metrics, best-effort and never fatal (see src/adoption.ts).
  // Recorded here rather than at the route so all four putObject callers are
  // covered by construction. `newSize` (not deltaBytes) is the right figure:
  // this counts bytes written by this upload, not net storage change.
  //
  // These writes land in different tables / are independent, and all are
  // never-throwing — so they run concurrently rather than as serial D1
  // round trips on every upload.
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
  ]);

  // Derived metadata from a content-identical earlier upload in this workspace
  // (issue #479) — rescues the paths the CLI sidecar cannot reach: the hosted
  // MCP, CI, a second machine. Never fires in the communal workspace; see
  // inheritableMetaForHash. Issued back at the hash, awaited here.
  const inherited = await inheritedPromise;

  // What actually landed in the queryable tier, echoed on the response (#511).
  let storedMetadata: Record<string, string> | undefined;

  if (opts?.metadata) {
    // Full replace: an overwrite must not inherit a prior put's custom
    // metadata, so clear the row set before (re-)writing this request's, in
    // one atomic batch (replaceFileMetadata) rather than a delete followed
    // by a separate re-read-then-write.
    storedMetadata = mergeWithinMetadataCaps(opts.metadata, inherited);
    await replaceFileMetadata(dbFor(env), workspaceName, finalKey, storedMetadata);
    // Explicit metadata only, never the inherited merge: inherited keys
    // describe the bytes, and letting them reach PR activity would attribute
    // the donor upload's PR to this one. (`gh.*` is not inheritable, so this
    // is belt and braces rather than the only guard.)
    await recordPrActivityFromMetadata(dbFor(env), workspaceName, opts.metadata);
  } else {
    // No `X-Uploads-Meta-*` headers: this put deliberately leaves an existing
    // object's tags alone, so inheritance must be additive rather than a
    // replace, which would wipe tags the caller never asked to change.
    storedMetadata = await applyInheritedMetaAdditively(
      dbFor(env),
      workspaceName,
      finalKey,
      inherited,
    );
  }

  // Index this object's bytes for future inheritance. Last, and best-effort:
  // the object is durably stored by now, so a failed index write costs a later
  // inheritance rather than this upload.
  await recordContentHash(dbFor(env), workspaceName, finalKey, contentSha256);

  // After the metadata replace, never before: replaceFileMetadata is
  // delete-then-insert and would wipe the server-owned video.*/image.* rows.
  await storeImageDimensions(env, workspaceName, finalKey, bytes, inspection.contentType);
  await generateAndStorePoster(
    env,
    ws,
    finalKey,
    bytes,
    inspection.contentType,
    workspaceName,
    storedVisibility,
  );

  const cfg = await storageConfig(env, ws);
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
  };
}

/** The shape `putObject` resolves to — reused by the idempotency reconcile path below. */
export type PutObjectResult = Awaited<ReturnType<typeof putObject>>;

/**
 * Reconciles a `key_exists` failure from an idempotent `PUT` retry (issue
 * #829): a prior attempt's bytes may already be durably stored even though its
 * idempotency claim never completed — a crash between the R2 write and the
 * downstream D1 work (metadata, content-hash index, PR activity). Heading the
 * object and synthesizing a response would report success while that D1 work
 * was never applied (e.g. `X-Uploads-Meta-*` tags silently dropped). So, only
 * when the stored object's `content-sha256` matches this retry's bytes — i.e.
 * it is our own interrupted upload — this re-drives `putObject` with `replace`,
 * converging the object to the intended state through the exact same
 * metadata/index/poster path a normal write uses. The cost is the accepted
 * one-off upload-ledger over-count on this rare recovery path.
 *
 * Returns `null` when there is no object at the key, or when one exists but its
 * content hash differs (a genuine conflict — the caller surfaces `key_exists`
 * rather than overwriting someone else's object).
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

  // Derived poster (issue #299), best-effort: a missing one is the norm for
  // every non-video object. THE security case — a private video must never
  // keep a publicly fetchable poster frame — so this propagation must land
  // before the primary flip, so a crash between the two calls never leaves
  // a private video with a still-public poster. (Widening is harmless in
  // this order too: a poster that stays private a moment longer than the
  // now-public video is not a confidentiality issue.)
  const posterKey = posterKeyFor(key);
  const posterExists = await store.head(posterKey).catch(() => null);
  if (posterExists) await rewriteVisibility(store, posterKey, visibility);

  await rewriteVisibility(store, key, visibility);
}

/**
 * Shared rewrite body for `setObjectVisibility`: download the object, flip
 * the `visibility` custom-metadata flag, and upload it back under the same
 * key. Extracted so the primary object and its derived poster (issue #299)
 * go through identical logic.
 */
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

/**
 * Shape HEAD/list-friendly metadata for API JSON. The object's R2 provenance
 * comes back as `provenance`; the queryable tier is a separate store and a
 * separate read, so it is served by `?metadata=1` on the same route rather
 * than costing every plain HEAD a D1 query.
 */
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
  /**
   * D1 `gh.*`-style queryable metadata for this key (file-metadata.ts). Never
   * populated here — `listObjects` only projects storage-provider fields;
   * callers that want metadata hydrate it separately (e.g. via
   * `getMetadataForKeys`) and merge it onto each row.
   */
  metadata?: Record<string, string>;
  /** Canonical public `/f/` page URL (issue #135). Present only when `url` is set and the workspace record carries a slug (`ws.name`, issue #303). */
  pageUrl?: string;
}

/**
 * Canonical public file-page URL (`/f/<workspace>/<key>`) for an object, built
 * against `WEB_ORIGIN` — the metadata-rich page apps/web serves (issues
 * #135/#139). Sibling to `galleryUrl`. Callers must not synthesize this;
 * the API returns it on the listing DTO.
 */
/** Server-owned namespace — derived posters, CLI report uploads. Never listed. */
const INTERNAL_KEY_PREFIX = "_internal/";

export function filePageUrl(env: Env, workspace: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${webOrigin(env)}/f/${encodeURIComponent(workspace)}/${encodedKey}`;
}

/** A provider-list item shape, before projection to the API's `ListedObject`. */
interface RawListedItem {
  key: string;
  size?: number;
  type?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
}

/** Shared HEAD/list projection, parameterized on which lane's config to derive URLs from — the single-lane and multi-lane `listObjects` paths both funnel through this. */
function projectListedObject(
  env: Env,
  ws: WorkspaceRecord,
  cfg: Awaited<ReturnType<typeof storageConfig>>,
  item: RawListedItem,
): ListedObject {
  const visibility = objectVisibility(item.metadata ?? undefined);
  const urls = objectPublicUrls(env, cfg, item.key);
  return {
    key: item.key,
    url: urls.url,
    embedUrl: urls.embedUrl,
    ...storedMetaJson(item),
    ...(visibility ? { visibility } : {}),
    ...(urls.url && ws.name ? { pageUrl: filePageUrl(env, ws.name, item.key) } : {}),
  };
}

/** One lane's fetched-and-filtered batch, tagged with enough state to resume it next page. */
interface LaneFetch {
  laneKeyStr: string;
  cfg: Awaited<ReturnType<typeof storageConfig>>;
  /** This batch's items, already dropped for anything at or before the composite cursor's high-water key. Empty (without ever fetching) when the lane was already `LANE_DONE`. */
  remaining: RawListedItem[];
  /** The provider cursor this fetch itself used (re-used verbatim next page if `remaining` isn't fully consumed this page) — `undefined` if the lane was already done (never fetched). */
  providerCursorUsed: string | undefined;
  /** The provider's own next-cursor for this batch, if it was truncated. */
  providerNextCursor: string | undefined;
  /** True when this lane was already `LANE_DONE` coming in — skipped entirely, no fetch made. */
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
    // Single-lane record (the entire fleet until a second lane exists):
    // exactly today's path — one provider call, today's raw opaque cursor,
    // no composite envelope. Backward compatible with an in-flight cursor.
    const cfg = configs[0].config;
    const store = createStorage(cfg);
    const result = await store.list({
      prefix: opts.prefix,
      delimiter: opts.delimiter,
      limit,
      cursor: opts.cursor,
    });
    return {
      // Server-owned derived artifacts (issue #299 posters, CLI report
      // uploads) are not user objects and must never appear as rows. Caveat:
      // `limit` applies to the underlying page *before* this filter, so a
      // page can come back shorter than `limit` while `cursor` is still
      // non-null — callers that paginate must follow the cursor, not stop on
      // a short page.
      items: result.items
        .filter((item) => !item.key.startsWith(INTERNAL_KEY_PREFIX))
        .map((item) => projectListedObject(env, ws, cfg, item)),
      cursor: result.cursor ?? null,
      ...(result.prefixes ? { prefixes: result.prefixes } : {}),
    };
  }

  // Multi-lane fan-out + merge (spec: "Listing: merged fan-out"). Garbage or
  // a plain (pre-lanes) cursor decodes to `null` — treated as a fresh start
  // rather than an error.
  const cursorMap = decodeLaneCursor(opts.cursor) ?? { v: 1, lanes: {} };
  // The global high-water key: nothing at or before it is ever re-emitted,
  // even if a lane's own resume state were somehow lost — defense in depth
  // alongside the explicit `LANE_DONE` sentinel below.
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

  // Tag each raw item with the config it came from (by object identity) so
  // the merge result can still be projected to a `ListedObject` per its
  // owning lane, without threading lane info through `mergeBounded`'s
  // generic `{ key }` constraint. `fetches` is already active-first order
  // (matches `storageConfigs`), which is exactly the merge priority order
  // `mergeBounded` wants.
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
      // Nothing left in this lane, ever — mark it explicitly done so the
      // next page skips fetching it entirely, rather than reinterpreting
      // "no entry" as "hasn't started yet" (the bug this cursor format
      // guards against — see decodeLaneResumeState).
      nextLanes[fetch.laneKeyStr] = LANE_DONE;
    } else if (fullyConsumed) {
      // Batch fully spent, but the provider says there's more — advance.
      nextLanes[fetch.laneKeyStr] = encodeLaneResumeState(fetch.providerNextCursor);
    } else {
      // Trimmed mid-batch: re-fetch the same provider cursor next page.
      // `highWater` (updated below) filters out what's already been
      // emitted, so this never re-emits a duplicate.
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

/** One lane's outcome for a `deleteFromEveryLane` call — the object's size and whether that lane is platform-owned (binding-mode), for ledger accounting. */
interface DeletedLaneHit {
  size: number;
  sharedLane: boolean;
}

/**
 * Delete `key` from every one of `configs`'s stores that actually holds it.
 * Probes every lane concurrently, then deletes concurrently from whichever
 * lanes hit via `Promise.allSettled` rather than `Promise.all` — one lane's
 * delete rejecting (network blip, stale binding) must not discard the fact
 * that a sibling lane's delete already succeeded. `hits` is exactly the set
 * of lanes whose delete actually completed, safe to debit from the ledger;
 * `failures` carries whatever rejected, for the caller to surface after
 * crediting the successes (never before — a delete that half-succeeds must
 * never look like it fully failed to the ledger). A retry against a lane
 * whose key is already gone can't double-debit: `existingSize` finds
 * nothing there on the next attempt. Two-lane storage: a key can exist in
 * more than one lane after a detach/re-attach cycle, and every copy must go
 * so the file actually disappears (spec: "Read path" — deletion).
 * Single-lane records take the exact path this always has: one lane, one
 * `existingSize` + `delete` call. Callers resolve `storageConfigs` once and
 * pass it in — `deleteObject` reuses the same resolution for both the
 * primary key and its poster.
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

/** Debits the ledger for every lane a delete actually removed the object from. Independent D1 rows per lane, none of which can throw (`recordUsageSafe`) — safe to run concurrently. */
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
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });

  const configs = await storageConfigs(env, ws);
  const { hits, failures } = await deleteFromEveryLane(configs, key);
  await deleteFileMetadata(dbFor(env), workspaceName, key);

  if (hits.length > 0) {
    // Single-winner claim (issue #570): concurrent DELETEs can both observe
    // the object and both reach this branch; only the first claimer debits
    // the ledger (and records the adoption delete metric). Claim after the
    // storage delete so a failed delete never burns the slot.
    const wonClaim = await claimDeleteUsageSafe(dbFor(env), workspaceName, key);
    if (wonClaim) {
      // Positive magnitude under the `delete` metric — never negative bytes
      // under `upload`. Net change is computed at read time. These two writes
      // land in different tables (workspace_usage vs daily_metrics), neither
      // depends on the other's result, and both are never-throwing — so they
      // run concurrently rather than as two serial D1 round trips per delete.
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
  // Every fulfilled lane is already credited above — only now does a
  // rejected lane's delete get to fail the request, so a partial failure
  // never looks like nothing happened.
  if (failures.length > 0) throw failures[0];

  // Derived poster (issue #299), best-effort: a missing one is the norm for
  // every non-video object. Guarded so a transient poster-cleanup failure
  // never fails a delete whose primary work already succeeded. Same
  // every-lane-that-has-it treatment as the primary object above.
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
