import { Hono, type Context } from "hono";
import { FileOpError, badKey, deleteObject, listObjects, putObject } from "../files-core";
import { publicUrl, storage, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";

/** Maps a core validation failure to the REST error shape; rethrows anything else. */
function mapFileOpError(c: Context, err: unknown): Response {
  if (err instanceof FileOpError) return c.json({ error: err.message }, 400);
  throw err;
}

export const files = new Hono<WorkspaceVars>()

  // Upload: raw body PUT. Content-Type header becomes the stored content type.
  .put("/:key{.+}", requireScope("files:write"), async (c) => {
    const body = await c.req.arrayBuffer();
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    try {
      const result = await putObject(
        c.env,
        c.get("workspace"),
        c.req.param("key"),
        new Uint8Array(body),
        contentType,
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
  .delete("/:key{.+}", requireScope("files:delete"), async (c) => {
    try {
      return c.json(await deleteObject(c.env, c.get("workspace"), c.req.param("key")));
    } catch (err) {
      return mapFileOpError(c, err);
    }
  });
