import { NotFoundError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  badKey,
  deleteObject,
  finalizeUploadKey,
  headObjectJson,
  listObjects,
  putObject,
} from "../files-core";
import { provenanceFromHeaders } from "../provenance";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";
import { checkDeclaredLength, resolveUploadPolicy, writeRateLimit } from "../guards";
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
      }>()
      .catch(
        () =>
          ({}) as {
            key?: string;
            contentType?: string;
            maxSize?: number;
            expiresIn?: number;
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

    // ?dryRun=1 — validate key + resolve public URL; no R2 write, no usage/budget check.
    // Prefixed keys match a real put; bare keys may re-govern to a new f/<id>/… on upload.
    const dryRun = c.req.query("dryRun");
    if (dryRun === "1" || dryRun === "true") {
      const ws = c.get("workspace");
      const finalKey = finalizeUploadKey(key, ws);
      const urls = objectPublicUrls(c.env, await storageConfig(c.env, ws), finalKey);
      return c.json({
        workspace: c.get("workspaceName"),
        key: finalKey,
        url: urls.url,
        embedUrl: urls.embedUrl,
        dryRun: true,
      });
    }

    const policy = resolveUploadPolicy(c.get("workspace"));
    const declared = checkDeclaredLength(c.req.header("Content-Length"), policy);
    if (declared) throw declared.error;

    const body = await c.req.arrayBuffer();
    const visibility = sanitizeVisibility(c.req.header("x-uploads-visibility"));
    const result = await putObject(
      c.env,
      c.get("workspace"),
      key,
      new Uint8Array(body),
      c.get("workspaceName"),
      { provenance: provenanceFromHeaders((n) => c.req.header(n)), visibility },
    );
    return c.json({ workspace: c.get("workspaceName"), ...result }, 201);
  })

  .get("/", requireScope("files:read"), async (c) => {
    const { prefix, cursor } = c.req.query();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    return c.json(await listObjects(c.env, c.get("workspace"), { prefix, limit, cursor }));
  })

  .get("/:key{.+}", requireScope("files:read"), async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
    const ws = c.get("workspace");
    const store = await storage(c.env, ws);
    if (!(await store.exists(key))) throw new NotFoundError();
    const meta = await store.head(key);
    const urls = objectPublicUrls(c.env, await storageConfig(c.env, ws), key);
    return c.json(headObjectJson(key, meta, urls.url, urls.embedUrl));
  })

  .delete("/:key{.+}", writeRateLimit, requireScope("files:delete"), async (c) => {
    return c.json(
      await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
    );
  });
