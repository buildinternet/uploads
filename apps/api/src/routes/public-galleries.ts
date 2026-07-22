import { NotFoundError, ServiceUnavailableError } from "@uploads/errors";
import { Hono } from "hono";
import { downloadResponse } from "../files-core";
import { listExternalReferences, listGalleryItems, resolvePublicGallery } from "../galleries";
import { galleryItemFilename, hydratePublicGallery } from "../gallery-service";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

/** Runs `action`, mapping any thrown error to the 503 the gallery storage routes commit to. */
async function withGalleryStorageErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new ServiceUnavailableError("Gallery storage unavailable.", {
      code: "gallery_storage_unavailable",
      cause,
    });
  }
}

export const publicGalleries = new Hono<WorkspaceVars>()
  .get("/:id/items/:item/download", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

    // Soft-deleted / purged workspaces collapse to null — same uniform 404 as
    // missing tenants (matches public-files + authenticated paths). Check
    // before item lookup so existing and unknown item IDs both yield
    // gallery_not_found for unavailable workspaces (no item-existence oracle).
    const workspace = await loadWorkspaceRecord(c.env, record.workspace);
    if (!workspace) {
      throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    }

    const items = await listGalleryItems(c.env.DB, record.workspace, record.id);
    const item = items.find((entry) => entry.id === c.req.param("item"));
    if (!item) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    const store = await withGalleryStorageErrors(() => storage(c.env, workspace));
    const exists = await withGalleryStorageErrors(() => store.exists(item.object_key));
    if (!exists) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    // Mirrors hydrateGalleryItems (gallery-service.ts): the object may have
    // been public at item-add time but the workspace's publicBaseUrl is
    // mutable afterward. Withhold the bytes here exactly when the gallery's
    // own read path would withhold the URL, so this route can't be used to
    // bypass that gate.
    const config = await withGalleryStorageErrors(() => storageConfig(c.env, workspace));
    const urls = objectPublicUrls(c.env, config, item.object_key);
    if (!urls.url) {
      throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
    }

    return withGalleryStorageErrors(() =>
      downloadResponse(store, item.object_key, galleryItemFilename(item.object_key)),
    );
  })
  .get("/:id", async (c) => {
    const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
    if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const workspace = await loadWorkspaceRecord(c.env, record.workspace);
    if (!workspace) {
      throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    }
    const [items, references] = await Promise.all([
      listGalleryItems(c.env.DB, record.workspace, record.id),
      listExternalReferences(c.env.DB, record.workspace, record.id),
    ]);
    return c.json(await hydratePublicGallery(c.env, workspace, record, items, references));
  });
