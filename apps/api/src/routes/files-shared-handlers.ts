import {
  ConflictError,
  NotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@uploads/errors";
import type { Context, Handler } from "hono";
import {
  badKey,
  finalizeUploadKey,
  headObjectJson,
  isManagedGithubKey,
  putObject,
} from "../files-core";
import { getFileMetadata, META_MAX_KEYS, setFileMetadata } from "../file-metadata";
import { checkDeclaredLength, maxBytesForContentType, resolveUploadPolicy } from "../guards";
import { splitUploadMetaHeaders } from "../provenance";
import { createLaneResolver, objectPublicUrls, resolveObjectLane, storage } from "../storage";
import { hasGithubTags, uploaderTags } from "../uploader-identity";
import { sanitizeVisibility } from "../visibility";
import type { WorkspaceVars } from "../workspace";

/** Handler shape shared by the legacy bearer and canonical dual-auth routers. */
export type SharedFilesHandler = Handler<WorkspaceVars>;

/** Normalize a client Content-Type for allowlist compare (type/subtype only, lowercased). */
function normalizePresignContentType(raw: string): string {
  const beforeParams = raw.split(";", 1)[0] ?? raw;
  return beforeParams.trim().toLowerCase();
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

  const policy = resolveUploadPolicy(ws);

  // Content-type is required on presign: the direct-to-bucket PUT cannot
  // magic-byte sniff, so the allowlist must be enforced at mint time.
  const rawContentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!rawContentType.trim()) {
    throw new ValidationError("contentType is required for presign", {
      code: "content_type_required",
    });
  }
  const contentType = normalizePresignContentType(rawContentType);
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
  const expiresIn =
    typeof body.expiresIn === "number" && body.expiresIn > 0 && body.expiresIn <= 86400
      ? Math.floor(body.expiresIn)
      : 3600;

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

  const policy = resolveUploadPolicy(c.get("workspace"));
  const declared = checkDeclaredLength(c.req.header("Content-Length"), policy);
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
  const result = await putObject(
    c.env,
    c.get("workspace"),
    key,
    new Uint8Array(body),
    c.get("workspaceName"),
    { provenance, visibility, metadata, replace: wantReplace, surface: "api" },
  );
  return c.json({ workspace: c.get("workspaceName"), ...result }, 201);
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
    const metadata = await getFileMetadata(c.env.DB, c.get("workspaceName"), key);
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
    c.env.DB,
    c.get("workspaceName"),
    key,
    (set as Record<string, string> | undefined) ?? {},
    (remove as string[] | undefined) ?? [],
  );
  return c.json({ metadata });
}
