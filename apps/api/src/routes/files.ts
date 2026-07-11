import { Hono, type Context } from "hono";
import { FileOpError, badKey, deleteObject, listObjects, putObject } from "../files-core";
import { publicUrl, storage, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";
import { checkDeclaredLength, resolveUploadPolicy, writeRateLimit } from "../guards";

/** Maps a core validation failure to the REST error shape; rethrows anything else. */
function mapFileOpError(c: Context, err: unknown): Response {
  if (err instanceof FileOpError) {
    return c.json(err.body, err.status as 400 | 413 | 415 | 429 | 507);
  }
  throw err;
}

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

    const key = typeof body.key === "string" ? body.key : "";
    if (!key || badKey(key)) return c.json({ error: "invalid key" }, 400);

    const ws = c.get("workspace");
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
      return c.json({
        workspace: c.get("workspaceName"),
        key,
        maxSize,
        expiresIn,
        publicUrl: publicUrl(cfg, key),
        upload,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ message: "presign failed", error: message }));
      return c.json(
        {
          error:
            "presign unavailable for this workspace (needs S3 HTTP credentials; binding-only cannot sign)",
          detail: message,
        },
        400,
      );
    }
  })

  // Upload: raw body PUT. The stored content type is sniffed from the bytes,
  // not taken from the client header — size/type policy is enforced in
  // files-core's putObject (shared with the MCP worker); see guards.ts.
  .put("/:key{.+}", writeRateLimit, requireScope("files:write"), async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const policy = resolveUploadPolicy(c.get("workspace"));
    const declared = checkDeclaredLength(c.req.header("Content-Length"), policy);
    if (declared) return c.json(declared.body, declared.status);

    const body = await c.req.arrayBuffer();
    try {
      const result = await putObject(
        c.env,
        c.get("workspace"),
        key,
        new Uint8Array(body),
        c.get("workspaceName"),
      );
      return c.json({ workspace: c.get("workspaceName"), ...result }, 201);
    } catch (err) {
      return mapFileOpError(c, err);
    }
  })

  .get("/", requireScope("files:read"), async (c) => {
    const { prefix, cursor } = c.req.query();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    return c.json(await listObjects(c.env, c.get("workspace"), { prefix, limit, cursor }));
  })

  .get("/:key{.+}", requireScope("files:read"), async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const ws = c.get("workspace");
    const store = await storage(c.env, ws);
    if (!(await store.exists(key))) return c.json({ error: "not found" }, 404);
    const meta = await store.head(key);
    return c.json({ ...meta, url: publicUrl(await storageConfig(c.env, ws), key) });
  })

  .delete("/:key{.+}", writeRateLimit, requireScope("files:delete"), async (c) => {
    try {
      return c.json(
        await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
      );
    } catch (err) {
      return mapFileOpError(c, err);
    }
  });
