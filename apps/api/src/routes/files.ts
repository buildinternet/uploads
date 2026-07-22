import { ConflictError, NotFoundError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  badKey,
  deleteObject,
  finalizeUploadKey,
  headObjectJson,
  isManagedGithubKey,
  listObjects,
  putObject,
} from "../files-core";
import {
  findObjectsByMetadata,
  getFileMetadata,
  getMetadataForKeys,
  META_MAX_KEYS,
  setFileMetadata,
  validateMetadataFilters,
} from "../file-metadata";
import { splitUploadMetaHeaders } from "../provenance";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";
import { checkDeclaredLength, resolveUploadPolicy, writeRateLimit } from "../guards";
import { hasGithubTags, uploaderTags } from "../uploader-identity";
import { sanitizeVisibility } from "../visibility";

export const files = new Hono<WorkspaceVars>()

  // Presigned direct-to-bucket upload (workspace needs S3 HTTP credentials).
  .post("/sign", writeRateLimit, requireScope("files:write"), async (c) => {
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
    const ceiling = Math.max(policy.maxBytes, policy.maxVideoBytes);
    const maxSize =
      typeof body.maxSize === "number" && body.maxSize > 0
        ? Math.min(body.maxSize, ceiling)
        : ceiling;
    const expiresIn =
      typeof body.expiresIn === "number" && body.expiresIn > 0 && body.expiresIn <= 86400
        ? Math.floor(body.expiresIn)
        : 3600;

    try {
      const store = await storage(c.env, ws);

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
      const replaced = await store.exists(key);
      if (replaced && !body.replace && !isManagedGithubKey(key)) {
        const cfg = await storageConfig(c.env, ws);
        const urls = objectPublicUrls(c.env, cfg, key);
        throw new ConflictError(
          `An object already exists at "${key}". Pass replace: true to sign an overwrite.`,
          { code: "key_exists", details: { key, url: urls.url, embedUrl: urls.embedUrl } },
        );
      }

      const upload = await store.signedUploadUrl(key, {
        expiresIn,
        contentType: body.contentType,
        maxSize,
      });
      const cfg = await storageConfig(c.env, ws);
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ message: "presign failed", error: message }));
      throw new ValidationError(
        "presign unavailable for this workspace (needs S3 HTTP credentials; binding-only cannot sign)",
        { code: "presign_unavailable", details: { detail: message }, cause: err },
      );
    }
  })

  // Upload: raw body PUT. The stored content type is sniffed from the bytes,
  // not taken from the client header — size/type policy is enforced in
  // files-core's putObject (shared with the MCP worker); see guards.ts.
  .put("/:key{.+}", writeRateLimit, requireScope("files:write"), async (c) => {
    const key = c.req.param("key");
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
      const store = await storage(c.env, ws);
      const replaced = await store.exists(finalKey);
      const wouldRefuse = replaced && !wantReplace && !isManagedGithubKey(finalKey);
      const urls = objectPublicUrls(c.env, await storageConfig(c.env, ws), finalKey);
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
      { provenance, visibility, metadata, replace: wantReplace },
    );
    return c.json({ workspace: c.get("workspaceName"), ...result }, 201);
  })

  // Repeatable `meta.<key>=<value>` params switch the listing to the D1
  // metadata index (ANDed equality across all given pairs) instead of the
  // R2 prefix-list below; see file-metadata.ts's `findObjectsByMetadata`.
  // No `meta.*` params at all leaves the existing R2 path untouched.
  // Contract caveat: D1-path items carry no `visibility` annotation (that
  // lives in R2 custom metadata and would cost a HEAD per result to
  // hydrate); callers needing the private marker must HEAD the object.
  .get("/", requireScope("files:read"), async (c) => {
    const query = c.req.query();
    const metaParamKeys = Object.keys(query).filter((k) => k.startsWith("meta."));

    if (metaParamKeys.length > 0) {
      // Duplicate-param detection is query-string-specific (repeated same
      // key), so it stays here; count cap + key format are shared with the
      // MCP find_files tool via validateMetadataFilters.
      const filters: Record<string, string> = {};
      for (const param of metaParamKeys) {
        const key = param.slice("meta.".length);
        const values = c.req.queries(param) ?? [];
        if (values.length > 1) {
          throw new ValidationError(`repeated metadata filter for key: ${key}`, {
            code: "file_metadata_duplicate_filter",
            details: { key },
          });
        }
        filters[key] = values[0] ?? query[param];
      }
      validateMetadataFilters(filters);

      const ws = c.get("workspace");
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Number(limitParam) || undefined : undefined;
      const [cfg, matches] = await Promise.all([
        storageConfig(c.env, ws),
        findObjectsByMetadata(c.env.DB, c.get("workspaceName"), filters, {
          prefix: query.prefix,
          limit,
        }),
      ]);
      return c.json({
        items: matches.map((match) => {
          const urls = objectPublicUrls(c.env, cfg, match.key);
          return {
            key: match.key,
            url: urls.url,
            embedUrl: urls.embedUrl,
            metadata: match.metadata,
          };
        }),
        cursor: null,
      });
    }

    const { prefix, cursor } = query;
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    const page = await listObjects(c.env, c.get("workspace"), { prefix, limit, cursor });

    // `?metadata=1` hydrates each row's queryable D1 metadata — same spelling
    // as `GET /v1/:workspace/files/:key?metadata=1` and the same hydration the
    // session-authed `/me/workspaces/:name/files` already does. Unfiltered by
    // design: this is a general-purpose listing, not the managed-comment path
    // (which narrows to `path`/`state` at its own query — issue #365).
    const metadataParam = c.req.query("metadata");
    if (metadataParam !== "1" && metadataParam !== "true") return c.json(page);

    const metaByKey = await getMetadataForKeys(
      c.env.DB,
      c.get("workspaceName"),
      page.items.map((item) => item.key),
    );
    return c.json({
      ...page,
      items: page.items.map((item) => ({ ...item, metadata: metaByKey.get(item.key) })),
    });
  })

  // Metadata now lives on the key-at-tail routes (same shape PUT/GET/DELETE
  // already use) instead of a `/:key{.+}/metadata` suffix route: Hono's
  // production router does not reliably match a `{.+}` param followed by a
  // static suffix once the key contains raw slashes (real object keys always
  // do) — the vitest harness matches raw slashes so this passed locally, but
  // the deployed worker 404s on any real key. `?metadata=1` on GET and a bare
  // PATCH (which has no other meaning on this route) avoid the fragile
  // suffix pattern entirely.
  .get("/:key{.+}", requireScope("files:read"), async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
    const ws = c.get("workspace");
    const store = await storage(c.env, ws);
    if (!(await store.exists(key))) throw new NotFoundError();

    const metadataParam = c.req.query("metadata");
    if (metadataParam === "1" || metadataParam === "true") {
      const metadata = await getFileMetadata(c.env.DB, c.get("workspaceName"), key);
      return c.json({ metadata });
    }

    const meta = await store.head(key);
    const urls = objectPublicUrls(c.env, await storageConfig(c.env, ws), key);
    return c.json(headObjectJson(key, meta, urls.url, urls.embedUrl));
  })

  .patch("/:key{.+}", writeRateLimit, requireScope("files:write"), async (c) => {
    const key = c.req.param("key");
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
  })

  .delete("/:key{.+}", writeRateLimit, requireScope("files:delete"), async (c) => {
    return c.json(
      await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
    );
  });
