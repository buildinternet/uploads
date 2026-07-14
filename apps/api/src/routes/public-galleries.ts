import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { downloadResponse } from "../files-core";
import { listExternalReferences, listGalleryItems, resolvePublicGallery } from "../galleries";
import { hydratePublicGallery } from "../gallery-service";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { type WorkspaceRecord, type WorkspaceVars } from "../workspace";

export const publicGalleries = new Hono<WorkspaceVars>()
  .get("/:id/items/:item/download", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

    const items = await listGalleryItems(c.env.DB, record.workspace, record.id);
    const item = items.find((entry) => entry.id === c.req.param("item"));
    if (!item) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    const workspace = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${record.workspace}`, {
      type: "json",
      cacheTtl: 60,
    });
    if (!workspace) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

    const store = await storage(c.env, workspace);
    if (!(await store.exists(item.object_key))) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    // Mirrors hydrateGalleryItems (gallery-service.ts): the object may have
    // been public at item-add time but the workspace's publicBaseUrl is
    // mutable afterward. Withhold the bytes here exactly when the gallery's
    // own read path would withhold the URL, so this route can't be used to
    // bypass that gate.
    const config = await storageConfig(c.env, workspace);
    const urls = objectPublicUrls(c.env, config, item.object_key);
    if (!urls.url) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    const filename = item.object_key.split("/").filter(Boolean).pop() ?? item.object_key;
    return downloadResponse(store, item.object_key, filename);
  })
  .get("/:id", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const workspace = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${record.workspace}`, {
      type: "json",
      cacheTtl: 60,
    });
    if (!workspace) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const [items, references] = await Promise.all([
      listGalleryItems(c.env.DB, record.workspace, record.id),
      listExternalReferences(c.env.DB, record.workspace, record.id),
    ]);
    return c.json(await hydratePublicGallery(c.env, workspace, record, items, references));
  });
