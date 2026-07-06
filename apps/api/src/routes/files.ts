import { Hono } from "hono";
import { publicUrl, storage, storageConfig } from "../storage";

const KEY_RE = /^[\w!*'().\/-]+$/;

function badKey(key: string): boolean {
  return (
    !KEY_RE.test(key) ||
    key.length > 1024 ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

export const files = new Hono<{ Bindings: Env }>()

  // Upload: raw body PUT. Content-Type header becomes the stored content type.
  .put("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: "empty body" }, 400);

    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    await storage(c.env).upload(key, new Uint8Array(body), { contentType });

    const url = publicUrl(storageConfig(c.env), key);
    return c.json({ key, url, size: body.byteLength, contentType }, 201);
  })

  // List
  .get("/", async (c) => {
    const { prefix, cursor } = c.req.query();
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000);
    const result = await storage(c.env).list({ prefix, limit, cursor });
    const cfg = storageConfig(c.env);
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
    const store = storage(c.env);
    if (!(await store.exists(key))) return c.json({ error: "not found" }, 404);
    const meta = await store.head(key);
    return c.json({ ...meta, url: publicUrl(storageConfig(c.env), key) });
  })

  // Delete
  .delete("/:key{.+}", async (c) => {
    const key = c.req.param("key");
    if (badKey(key)) return c.json({ error: "invalid key" }, 400);
    await storage(c.env).delete(key);
    return c.json({ key, deleted: true });
  });
