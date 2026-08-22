/**
 * Workspace file operations shared by the REST routes (routes/files.ts) and
 * the remote MCP worker (apps/mcp) — one code path for key/body validation,
 * storage I/O, and result shapes. Validation failures throw AppError subclasses
 * from `@uploads/errors`; REST serializes via `respondError`, MCP surfaces
 * `message` in the tool error.
 */
import { ConflictError, NotFoundError, ValidationError } from "@uploads/errors";
import { createStorage, type Files } from "@uploads/storage";
import { recordAdoptionSafe, type UploadSurface } from "./adoption";
import {
  budgetDenialError,
  checkPutBudget,
  enforcedMaxStorageBytes,
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
import { DEFAULT_MAX_UPLOAD_BYTES, inspectUpload, resolveUploadPolicy } from "./guards";
import { checkKeyPolicy, resolveKeyPolicy } from "./key-policy";
import { decodeLaneCursor, encodeLaneCursor, mergeBounded } from "./lane-list";
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
import { objectPublicUrls, storage, storageConfig, storageConfigs } from "./storage";
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
        await deleteServerFileMetadataKeys(env.DB, workspaceName, key, POSTER_META_KEYS);
        // Single-winner claim (issue #570) — same gate as deleteObject.
        if (await claimDeleteUsageSafe(env.DB, workspaceName, posterKey)) {
          await recordUsageSafe(env.DB, workspaceName, {
            bytes: -stale,
            objects: -1,
            uploads: 0,
          });
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
    await clearDeleteUsageClaimSafe(env.DB, workspaceName, posterKey);
    // Counted because reconcileWorkspaceUsage walks every object under the
    // prefix and would otherwise disagree with the ledger permanently.
    await recordUsageSafe(env.DB, workspaceName, {
      bytes: made.jpeg.byteLength - (previous ?? 0),
      objects: previous === null ? 1 : 0,
      uploads: 0,
    });
    // Full replace, not upsert: a regeneration whose probe/extraction found
    // fewer fields than the prior poster (e.g. no dims this time) must not
    // leave stale video.width/height/duration rows behind.
    await deleteServerFileMetadataKeys(env.DB, workspaceName, key, POSTER_META_KEYS);
    await setServerFileMetadata(env.DB, workspaceName, key, made.meta);
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

  const inspection = inspectUpload(bytes, resolveUploadPolicy(ws));
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

  const usage = await getWorkspaceUsage(env.DB, workspaceName);
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
  const uploadReservation = await reserveUploads(env.DB, workspaceName, 1, maxUploadsPerPeriod);
  if (!uploadReservation.ok) {
    throw budgetDenialError(
      uploadBudgetDenial(uploadReservation.usage, uploadReservation.maxUploadsPerPeriod),
    );
  }

  const storageReservation = await reserveStorageBytes(
    env.DB,
    workspaceName,
    deltaBytes,
    maxStorageBytes,
  );
  if (!storageReservation.ok) {
    await releaseUploadsSafe(env.DB, workspaceName, 1);
    throw budgetDenialError(
      storageBudgetDenial(
        storageReservation.usage,
        storageReservation.maxStorageBytes,
        storageReservation.deltaBytes,
      ),
    );
  }
  const reservedBytes = storageReservation.reservedBytes;

  // Client headers first; always attach content-sha256 of the final stored body
  // (never trust a client-supplied hash). Visibility lives alongside provenance
  // in the same custom-metadata bag but is tracked separately (not client-free-form).
  // `uploaded-at` is server-only — set on the final bag, never via sanitizeProvenance.
  const contentSha256 = await contentSha256Hex(bytes);
  // Started here rather than where it is consumed, so this D1 read overlaps the
  // R2 write and usage accounting instead of adding its latency after them. Safe
  // to leave in flight: inheritableMetaForHash never rejects (it resolves to `{}`
  // on any failure), so an upload that throws below cannot orphan a rejection.
  const inheritedPromise = inheritableMetaForHash(env.DB, workspaceName, contentSha256, finalKey);
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
    // Nothing was stored — return both reservations to the budget.
    await releaseUploadsSafe(env.DB, workspaceName, 1);
    await releaseStorageBytesSafe(env.DB, workspaceName, reservedBytes);
    throw err;
  }

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
    recordUsageSafe(env.DB, workspaceName, {
      bytes: reservedBytes > 0 ? 0 : deltaBytes,
      objects: replaced ? 0 : 1,
      uploads: 0,
    }),
    clearDeleteUsageClaimSafe(env.DB, workspaceName, finalKey),
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
    await replaceFileMetadata(env.DB, workspaceName, finalKey, storedMetadata);
    // Explicit metadata only, never the inherited merge: inherited keys
    // describe the bytes, and letting them reach PR activity would attribute
    // the donor upload's PR to this one. (`gh.*` is not inheritable, so this
    // is belt and braces rather than the only guard.)
    await recordPrActivityFromMetadata(env.DB, workspaceName, opts.metadata);
  } else {
    // No `X-Uploads-Meta-*` headers: this put deliberately leaves an existing
    // object's tags alone, so inheritance must be additive rather than a
    // replace, which would wipe tags the caller never asked to change.
    storedMetadata = await applyInheritedMetaAdditively(env.DB, workspaceName, finalKey, inherited);
  }

  // Index this object's bytes for future inheritance. Last, and best-effort:
  // the object is durably stored by now, so a failed index write costs a later
  // inheritance rather than this upload.
  await recordContentHash(env.DB, workspaceName, finalKey, contentSha256);

  // After the metadata replace, never before: replaceFileMetadata is
  // delete-then-insert and would wipe the server-owned video.* rows.
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

/**
 * Packs a lane's next-fetch state into one opaque string: how many items to
 * skip past a batch already fetched from `cursor` (a lane whose merged page
 * didn't consume its whole fetched batch must resume mid-batch — providers
 * only support resuming at a *batch* boundary, so the leftover is re-fetched
 * and re-skipped rather than lost), plus the underlying provider cursor to
 * fetch that batch from (`undefined` = start of listing). Internal to
 * `listObjects`'s multi-lane fan-out — `LaneCursorMap`'s value type is just
 * `string`, so this format is a private implementation detail of this file.
 */
function encodeLaneResumeState(skip: number, cursor: string | undefined): string {
  return `${skip}:${cursor ?? ""}`;
}

function decodeLaneResumeState(raw: string | undefined): {
  skip: number;
  cursor: string | undefined;
} {
  const sep = raw?.indexOf(":") ?? -1;
  if (raw === undefined || sep < 0) return { skip: 0, cursor: undefined };
  const skip = Number(raw.slice(0, sep));
  const cursor = raw.slice(sep + 1);
  return {
    skip: Number.isFinite(skip) && skip >= 0 ? skip : 0,
    cursor: cursor.length > 0 ? cursor : undefined,
  };
}

/** One lane's fetched-and-filtered batch, tagged with enough state to resume it next page. */
interface LaneFetch {
  laneKeyStr: string;
  cfg: Awaited<ReturnType<typeof storageConfig>>;
  /** This batch's items after dropping the portion already emitted on an earlier page. */
  remaining: RawListedItem[];
  /** How many of this batch's items were already skipped before this fetch (for the next page's bookkeeping). */
  skipBase: number;
  /** The provider cursor this fetch itself used (re-used verbatim if `remaining` isn't fully consumed this page). */
  providerCursorUsed: string | undefined;
  /** The provider's own next-cursor for this batch, if it was truncated. */
  providerNextCursor: string | undefined;
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
  const laneCursorKey = (laneId: string | null) => laneId ?? ACTIVE_LANE_CURSOR_KEY;

  const prefixesSeen: string[] = [];
  const fetches: LaneFetch[] = await Promise.all(
    configs.map(async (lc): Promise<LaneFetch> => {
      const laneKeyStr = laneCursorKey(lc.laneId);
      const { skip, cursor: providerCursor } = decodeLaneResumeState(cursorMap.lanes[laneKeyStr]);
      const store = createStorage(lc.config);
      const result = await store.list({
        prefix: opts.prefix,
        delimiter: opts.delimiter,
        limit,
        cursor: providerCursor,
      });
      for (const p of result.prefixes ?? []) if (!prefixesSeen.includes(p)) prefixesSeen.push(p);
      const filtered = result.items.filter((item) => !item.key.startsWith(INTERNAL_KEY_PREFIX));
      return {
        laneKeyStr,
        cfg: lc.config,
        remaining: filtered.slice(skip),
        skipBase: skip,
        providerCursorUsed: providerCursor,
        providerNextCursor: result.cursor,
      };
    }),
  );

  // Tag each raw item with the config it came from (by object identity) so
  // the merge result can still be projected to a `ListedObject` per its
  // owning lane, without threading lane info through `mergeBounded`'s
  // generic `{ key }` constraint.
  const taggedPages = fetches.map((fetch, laneOrder) => ({
    laneOrder,
    items: fetch.remaining.map((raw) => ({ ...raw, __cfg: fetch.cfg })),
  }));
  const merged = mergeBounded(taggedPages, limit);

  const nextLanes: Record<string, string> = {};
  fetches.forEach((fetch, i) => {
    const consumedCount = merged.consumed[i] ?? 0;
    if (consumedCount >= fetch.remaining.length) {
      // This batch is fully spent. More to come only if the provider itself
      // wasn't exhausted — advance to its next batch, skip reset to 0.
      if (fetch.providerNextCursor) {
        nextLanes[fetch.laneKeyStr] = encodeLaneResumeState(0, fetch.providerNextCursor);
      }
    } else {
      // Trimmed mid-batch: re-fetch the same provider cursor next page and
      // skip further ahead — providers only resume at a batch boundary.
      nextLanes[fetch.laneKeyStr] = encodeLaneResumeState(
        fetch.skipBase + consumedCount,
        fetch.providerCursorUsed,
      );
    }
  });

  return {
    items: merged.items.map((raw) => projectListedObject(env, ws, raw.__cfg, raw)),
    cursor: Object.keys(nextLanes).length > 0 ? encodeLaneCursor({ v: 1, lanes: nextLanes }) : null,
    ...(prefixesSeen.length > 0 ? { prefixes: prefixesSeen } : {}),
  };
}

/**
 * Delete `key` from every lane's store that actually holds it and return the
 * size reported by the first lane hit (active-first order) — `null` if no
 * lane had it. Two-lane storage: a key can exist in more than one lane after
 * a detach/re-attach cycle, and every copy must go so the file actually
 * disappears (spec: "Read path" — deletion). Single-lane records take the
 * exact path this always has: one lane, one `existingSize` + `delete` call.
 */
async function deleteFromEveryLane(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<number | null> {
  const configs = await storageConfigs(env, ws);
  let prev: number | null = null;
  for (const lc of configs) {
    const store = createStorage(lc.config);
    const size = await existingSize(store, key);
    if (size === null) continue;
    if (prev === null) prev = size;
    await store.delete(key);
  }
  return prev;
}

/** Delete an object (and its D1 custom metadata) and decrement the workspace ledger when size was known. */
export async function deleteObject(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
  workspaceName: string,
): Promise<{ key: string; deleted: true }> {
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });

  const prev = await deleteFromEveryLane(env, ws, key);
  await deleteFileMetadata(env.DB, workspaceName, key);

  if (prev !== null) {
    // Single-winner claim (issue #570): concurrent DELETEs can both observe
    // the object and both reach this branch; only the first claimer debits
    // the ledger (and records the adoption delete metric). Claim after the
    // storage delete so a failed delete never burns the slot.
    const wonClaim = await claimDeleteUsageSafe(env.DB, workspaceName, key);
    if (wonClaim) {
      // Positive magnitude under the `delete` metric — never negative bytes
      // under `upload`. Net change is computed at read time. These two writes
      // land in different tables (workspace_usage vs daily_metrics), neither
      // depends on the other's result, and both are never-throwing — so they
      // run concurrently rather than as two serial D1 round trips per delete.
      await Promise.all([
        recordUsageSafe(env.DB, workspaceName, {
          bytes: -prev,
          objects: -1,
          uploads: 0,
        }),
        recordAdoptionSafe(env, { metric: "delete", workspace: workspaceName, bytes: prev }),
      ]);
    }
  }

  // Derived poster (issue #299), best-effort: a missing one is the norm for
  // every non-video object. Guarded so a transient poster-cleanup failure
  // never fails a delete whose primary work already succeeded. Same
  // every-lane-that-has-it treatment as the primary object above.
  const posterKey = posterKeyFor(key);
  try {
    const posterPrev = await deleteFromEveryLane(env, ws, posterKey);
    if (posterPrev !== null) {
      if (await claimDeleteUsageSafe(env.DB, workspaceName, posterKey)) {
        await recordUsageSafe(env.DB, workspaceName, {
          bytes: -posterPrev,
          objects: -1,
          uploads: 0,
        });
      }
    }
  } catch (err) {
    console.error({ event: "poster_delete_failed", workspace: workspaceName, key, err });
  }

  return { key, deleted: true };
}
