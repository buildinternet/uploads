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

  // Upload: raw body PUT. The stored content type is sniffed from the bytes,
  // not taken from the client header — size/type policy is enforced in
  // files-core's putObject (shared with the MCP worker); see guards.ts.
  .put("/:key{.+}", writeRateLimit, requireScope("files:write"), async (c) => {
    // Fail fast on a bad key and on an oversized declared length before
    // buffering the body into isolate memory; putObject re-checks both.
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

  // List
  .get("/", requireScope("files:read"), async (c) => {
    const { prefix, cursor } = c.req.query();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    return c.json(await listObjects(c.env, c.get("workspace"), { prefix, limit, cursor }));
  })

  // Metadata
  .get("/:key{.+}", requireScope("files:read"), async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const ws = c.get("workspace");
    const store = storage(c.env, ws);
    if (!(await store.exists(key))) return c.json({ error: "not found" }, 404);
    const meta = await store.head(key);
    return c.json({ ...meta, url: publicUrl(storageConfig(c.env, ws), key) });
  })

  // Delete
  .delete("/:key{.+}", writeRateLimit, requireScope("files:delete"), async (c) => {
    try {
      return c.json(
        await deleteObject(c.env, c.get("workspace"), c.req.param("key"), c.get("workspaceName")),
      );
    } catch (err) {
      return mapFileOpError(c, err);
    }
  });
