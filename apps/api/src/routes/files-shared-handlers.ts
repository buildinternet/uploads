import {
  ConflictError,
  NotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@uploads/errors";
import type { Context, Handler } from "hono";
import { activeContentAllowed } from "../active-content";
import {
  badKey,
  finalizeUploadKey,
  headObjectJson,
  isManagedGithubKey,
  putObject,
  reconcileInterruptedUpload,
} from "../files-core";
import { getFileMetadata, META_MAX_KEYS, setFileMetadata } from "../file-metadata";
import {
  checkDeclaredLength,
  isGatedContentType,
  maxBytesForContentType,
  normalizeDeclaredContentType,
  resolveDeclaredContentType,
  resolveUploadPolicy,
  uploadLimits,
} from "../guards";
import { contentSha256Hex, splitUploadMetaHeaders } from "../provenance";
import { createLaneResolver, objectPublicUrls, resolveObjectLane, storage } from "../storage";
import { hasGithubTags, uploaderTags } from "../uploader-identity";
import { putObjectIdempotently } from "../upload-idempotency";
import { sanitizeVisibility } from "../visibility";
import type { WorkspaceVars } from "../workspace";
import { dbFor, primaryDbFor } from "../db-session";

/** Handler shape shared by the legacy bearer and canonical dual-auth routers. */
export type SharedFilesHandler = Handler<WorkspaceVars>;

/**
 * Ceiling on a presigned URL's lifetime when the declared type is a gated
 * SVG/XML one (issue #929 adversarial review L-5). Long enough for any
 * realistic direct-to-bucket PUT, short enough that turning the gate off
 * takes effect in minutes rather than the 24 hours every other type gets.
 */
const GATED_PRESIGN_MAX_EXPIRES_IN_S = 900;

/** Default presigned-URL lifetime, and the ceiling an ungated type may ask for. */
const DEFAULT_PRESIGN_EXPIRES_IN_S = 3600;
const MAX_PRESIGN_EXPIRES_IN_S = 86_400;

/**
 * The lifetime a presigned URL actually gets. A request outside
 * `(0, 86400]` — or none at all — falls back to an hour, exactly as it
 * always has; a gated SVG/XML type is then capped at
 * {@link GATED_PRESIGN_MAX_EXPIRES_IN_S}, because that URL writes to the
 * bucket later with nothing on the write path able to re-ask the gate
 * (issue #929 adversarial review L-5). Exported for direct testing: the
 * route around it needs signable HTTP credentials to reach a response body
 * at all, and this arithmetic is the whole of the rule.
 */
export function presignExpiresIn(requested: unknown, contentType: string): number {
  const asked =
    typeof requested === "number" && requested > 0 && requested <= MAX_PRESIGN_EXPIRES_IN_S
      ? Math.floor(requested)
      : DEFAULT_PRESIGN_EXPIRES_IN_S;
  return isGatedContentType(contentType) ? Math.min(asked, GATED_PRESIGN_MAX_EXPIRES_IN_S) : asked;
}

export async function signFileHandler(c: Context<WorkspaceVars>) {
  const body = await c.req
    .json<{
      key?: string;
      contentType?: string;
      maxSize?: number;
      expiresIn?: number;
      replace?: boolean;
    }>()
    .catch(
      () =>
        ({}) as {
          key?: string;
          contentType?: string;
          maxSize?: number;
          expiresIn?: number;
          replace?: boolean;
        },
    );

  const rawKey = typeof body.key === "string" ? body.key : "";
  if (!rawKey) throw new ValidationError("invalid key", { code: "invalid_key" });

  const ws = c.get("workspace");
  const key = finalizeUploadKey(rawKey, ws);

  const policy = resolveUploadPolicy(ws, { activeContent: await activeContentAllowed(c.env, ws) });

  // Content-type is required on presign: the direct-to-bucket PUT cannot
  // magic-byte sniff, so the allowlist must be enforced at mint time.
  const rawContentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!rawContentType.trim()) {
    throw new ValidationError("contentType is required for presign", {
      code: "content_type_required",
    });
  }
  const contentType = normalizeDeclaredContentType(rawContentType);
  if (!policy.allowed.has(contentType)) {
    throw new UnsupportedMediaTypeError("unsupported media type", {
      code: "unsupported_media_type",
      details: { allowed: [...policy.allowed] },
    });
  }

  const typeCeiling = maxBytesForContentType(policy, contentType);
  const maxSize =
    typeof body.maxSize === "number" && body.maxSize > 0
      ? Math.min(body.maxSize, typeCeiling)
      : typeCeiling;
  const expiresIn = presignExpiresIn(body.expiresIn, contentType);

  try {
    // Two-lane storage: an existing object may live in a fallback lane
    // rather than the active one this presign will write to — the conflict
    // check (and the URL it reports) must still find it there. `resolver`
    // caches the active lane's store/config, so the conflict-check walk and
    // the trailing URL derivation below resolve the active lane exactly
    // once between them, not once each.
    const resolver = createLaneResolver(c.env, ws);
    const [store, existingLane] = await Promise.all([
      resolver.activeStore(),
      resolver.resolve(key),
    ]);

    // Strict-overwrite gate (issue #174), best-effort here: /sign mints a
    // presigned URL for a direct-to-bucket PUT that happens later (up to
    // `expiresIn`, max 24h) and entirely outside this worker, so there is
    // no atomic check-then-write available the way there is in the
    // regular PUT route (files-core.ts `putObject`) — the client may sign
    // now and write minutes or hours after this check, or never. This
    // still rejects the common case (an existing strict key, checked at
    // mint time) and mirrors the PUT route's `replace` opt-in / gh/
    // hot-swap exemption, but it is NOT a security boundary: a signed URL
    // for a free key can still land on an object created after signing.
    // Treat this as UX guardrail parity with PUT, not a guarantee.
    if (existingLane && !body.replace && !isManagedGithubKey(key)) {
      const urls = objectPublicUrls(c.env, existingLane.config, key);
      throw new ConflictError(
        `An object already exists at "${key}". Pass replace: true to sign an overwrite.`,
        { code: "key_exists", details: { key, url: urls.url, embedUrl: urls.embedUrl } },
      );
    }

    const upload = await store.signedUploadUrl(key, {
      expiresIn,
      contentType,
      maxSize,
    });
    const cfg = await resolver.activeConfig();
    const urls = objectPublicUrls(c.env, cfg, key);
    return c.json({
      workspace: c.get("workspaceName"),
      key,
      maxSize,
      expiresIn,
      publicUrl: urls.url,
      embedUrl: urls.embedUrl,
      upload,
    });
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    if (err instanceof ValidationError || err instanceof UnsupportedMediaTypeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "presign failed", error: message }));
    throw new ValidationError(
      "presign unavailable for this workspace (needs S3 HTTP credentials; binding-only cannot sign)",
      { code: "presign_unavailable", cause: err },
    );
  }
}

export async function putFileHandler(c: Context<WorkspaceVars>) {
  const key = c.req.param("key")!;
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });

  // ?replace=1 (or header X-Uploads-Replace: 1) — opt in to overwriting an
  // existing object on a "strict" (non-`gh/`) key; see files-core.ts
  // `putObject`'s `replace` option / issue #174. Ignored on managed `gh/`
  // paths, which always hot-swap.
  const replaceParam = c.req.query("replace") ?? c.req.header("x-uploads-replace");
  const wantReplace = replaceParam === "1" || replaceParam === "true";

  // ?dryRun=1 — validate key + resolve public URL; no R2 write, no usage/budget check.
  // Prefixed keys match a real put; bare keys may re-govern to a new f/<id>/… on upload.
  // `replaced` is whether an object already lives at the final key (would overwrite);
  // `wouldRefuse` mirrors the real-put strict-overwrite gate so dry-run previews it too.
  const dryRun = c.req.query("dryRun");
  if (dryRun === "1" || dryRun === "true") {
    const ws = c.get("workspace");
    const finalKey = finalizeUploadKey(key, ws);
    // Two-lane storage: preview against whichever lane actually holds the
    // key today (a fallback-only key still counts as "would overwrite").
    // `resolver` caches the active lane's config, so the not-found branch
    // below reuses the same resolve `resolve()` already did internally,
    // rather than a second `storageConfig` call.
    const resolver = createLaneResolver(c.env, ws);
    const existingLane = await resolver.resolve(finalKey);
    const replaced = existingLane !== null;
    const wouldRefuse = replaced && !wantReplace && !isManagedGithubKey(finalKey);
    const urls = existingLane
      ? objectPublicUrls(c.env, existingLane.config, finalKey)
      : objectPublicUrls(c.env, await resolver.activeConfig(), finalKey);
    return c.json({
      workspace: c.get("workspaceName"),
      key: finalKey,
      url: urls.url,
      embedUrl: urls.embedUrl,
      replaced,
      wouldRefuse,
      dryRun: true,
    });
  }

  const ws = c.get("workspace");
  const finalKey = finalizeUploadKey(key, ws);
  // Ceilings only, no admission decision — `putObject` is what actually gates
  // SVG/XML acceptance, against the fully-buffered body (see `uploadLimits`).
  // Passing the claimed type tightens this to that type's own ceiling, so a
  // declared 50 MB SVG is refused before the body is buffered at all rather
  // than after the gated rows' 4 MiB cap (issue #929) sees it.
  const declaredContentType = resolveDeclaredContentType(c.req.header("Content-Type"), finalKey);
  const declared = checkDeclaredLength(
    c.req.header("Content-Length"),
    uploadLimits(ws),
    declaredContentType,
  );
  if (declared) throw declared.error;

  const body = await c.req.arrayBuffer();
  const visibility = sanitizeVisibility(c.req.header("x-uploads-visibility"));
  const { provenance, custom } = splitUploadMetaHeaders(c.req.raw.headers);
  // No custom (non-provenance) X-Uploads-Meta-* headers at all: pass
  // `metadata: undefined` so putObject leaves any existing D1 metadata
  // untouched (matches the MCP `put` tool's omit-preserves semantics).
  // At least one custom header: keep the existing full-replace behavior,
  // even when that header's value alone ends up empty/invalid (putObject
  // still validates and rejects before any write).
  const hasCustomMeta = Object.keys(custom).length > 0;
  // Uploader attribution (issue #340): gh.*-tagged uploads get server-derived
  // `gh.uploader`/`gh.uploader-id` stamped from the bearer token's minting
  // user — spread AFTER the client's pairs so a client-supplied value of
  // those keys can't impersonate someone else. Attribution only (a shared
  // token attributes to its minter); non-gh uploads and legacy tokens are
  // untouched.
  let metadata = hasCustomMeta ? custom : undefined;
  if (metadata && hasGithubTags(metadata)) {
    const uploader = await uploaderTags(c.env, c.get("mintingUserId"), metadata["gh.repo"]);
    if (uploader) {
      // Attribution must never break an upload that was valid without it:
      // if the merged set would blow the per-object key cap (validated
      // inside putObject), keep the client's pairs and drop the server tags.
      const merged = { ...metadata, ...uploader };
      if (Object.keys(merged).length <= META_MAX_KEYS) metadata = merged;
    }
  }
  const bytes = new Uint8Array(body);
  const workspaceName = c.get("workspaceName");
  const putOpts = {
    provenance,
    visibility,
    metadata,
    replace: wantReplace,
    surface: "api" as const,
    declaredContentType: c.req.header("Content-Type"),
  };

  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey === undefined) {
    const result = await putObject(c.env, ws, key, bytes, workspaceName, putOpts);
    return c.json({ workspace: workspaceName, ...result }, 201);
  }

  // Hash the body once, up front: it anchors the fingerprint and the reconcile
  // check, and is threaded into putObject so it isn't hashed a second time.
  const contentSha256 = await contentSha256Hex(bytes);
  const idempotentPutOpts = { ...putOpts, contentSha256 };
  let result;
  try {
    result = await putObjectIdempotently(primaryDbFor(c.env), {
      workspace: workspaceName,
      principal: c.get("authPrincipal"),
      key: idempotencyKey,
      fingerprint: {
        finalKey,
        contentSha256,
        visibility,
        replace: wantReplace,
        metadata,
        declaredContentType,
      },
      run: () => putObject(c.env, ws, key, bytes, workspaceName, idempotentPutOpts),
      reconcile: () =>
        reconcileInterruptedUpload(c.env, ws, workspaceName, key, bytes, contentSha256, putOpts),
      readEnv: c.env,
    });
  } catch (error) {
    if (error instanceof ConflictError && error.code === "idempotency_request_in_progress") {
      c.header("Retry-After", "1");
    }
    throw error;
  }
  if (result.replayed) c.header("Idempotency-Replayed", "true");
  return c.json({ workspace: workspaceName, ...result.value }, 201);
}

export async function getFileHandler(c: Context<WorkspaceVars>) {
  const key = c.req.param("key")!;
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
  const ws = c.get("workspace");
  // Two-lane storage: a key uploaded before a storage switch still resolves,
  // from whichever lane actually holds it.
  const lane = await resolveObjectLane(c.env, ws, key);
  if (!lane) throw new NotFoundError();

  const metadataParam = c.req.query("metadata");
  if (metadataParam === "1" || metadataParam === "true") {
    const metadata = await getFileMetadata(dbFor(c.env), c.get("workspaceName"), key);
    return c.json({ metadata });
  }

  const meta = await lane.store.head(key);
  const urls = objectPublicUrls(c.env, lane.config, key);
  return c.json(headObjectJson(key, meta, urls.url, urls.embedUrl));
}

export async function patchFileHandler(c: Context<WorkspaceVars>) {
  const key = c.req.param("key")!;
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
  const ws = c.get("workspace");
  const store = await storage(c.env, ws);
  if (!(await store.exists(key))) throw new NotFoundError();

  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("invalid request body", { code: "invalid_body" });
  }
  const { set, delete: remove } = body as {
    set?: unknown;
    delete?: unknown;
  };
  if (set !== undefined && (typeof set !== "object" || set === null || Array.isArray(set))) {
    throw new ValidationError("`set` must be an object of string values", {
      code: "invalid_body",
    });
  }
  if (set !== undefined) {
    for (const value of Object.values(set as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new ValidationError("`set` values must be strings", { code: "invalid_body" });
      }
    }
  }
  if (
    remove !== undefined &&
    (!Array.isArray(remove) || remove.some((item) => typeof item !== "string"))
  ) {
    throw new ValidationError("`delete` must be an array of strings", {
      code: "invalid_body",
    });
  }

  const metadata = await setFileMetadata(
    dbFor(c.env),
    c.get("workspaceName"),
    key,
    (set as Record<string, string> | undefined) ?? {},
    (remove as string[] | undefined) ?? [],
  );
  return c.json({ metadata });
}
