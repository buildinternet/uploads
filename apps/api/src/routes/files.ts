import { Hono } from "hono";
import { publicUrl, storage, storageConfig } from "../storage";
import type { WorkspaceVars } from "../workspace";

const KEY_RE = /^[\w!*'()./-]+$/;

function badKey(key: string): boolean {
  return (
    !KEY_RE.test(key) ||
    key.length > 1024 ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

export const files = new Hono<WorkspaceVars>()

  // Upload: raw body PUT. Content-Type header becomes the stored content type.
  .put("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: "empty body" }, 400);

    const ws = c.get("workspace");
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    await storage(c.env, ws).upload(key, new Uint8Array(body), { contentType });

    const url = publicUrl(storageConfig(c.env, ws), key);
    return c.json(
      { workspace: c.get("workspaceName"), key, url, size: body.byteLength, contentType },
      201,
    );
  })

  // List
  .get("/", async (c) => {
    const { prefix, cursor } = c.req.query();
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000);
    const ws = c.get("workspace");
    const result = await storage(c.env, ws).list({ prefix, limit, cursor });
    const cfg = storageConfig(c.env, ws);
    return c.json({
      items: result.items.map((item: { key: string }) => ({
        ...item,
        url: publicUrl(cfg, item.key),
      })),
      cursor: result.cursor ?? null,
    });
  })

  // Metadata
  .get("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const ws = c.get("workspace");
    const store = storage(c.env, ws);
    if (!(await store.exists(key))) return c.json({ error: "not found" }, 404);
    const meta = await store.head(key);
    return c.json({ ...meta, url: publicUrl(storageConfig(c.env, ws), key) });
  })

  // Delete
  .delete("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    await storage(c.env, c.get("workspace")).delete(key);
    return c.json({ key, deleted: true });
  });
