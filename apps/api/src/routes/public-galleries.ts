import { withPublicReadTiming } from "../public-read-timing";
import { NotFoundError, ServiceUnavailableError } from "@uploads/errors";
import { Hono } from "hono";
import { downloadResponse } from "../files-read";
import { listGalleryItems, resolvePublicGallery } from "../galleries";
import { hydratePublicGallery } from "../gallery-service";
import { createLaneResolver, isSharedLane, objectPublicUrls } from "../storage";
import { isKeyHeld } from "../upload-hold-read";
import { applyVisibilityOverride, objectVisibility } from "../visibility";
import { readVisibilityRows } from "../file-metadata";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
import { dbFor } from "../db-session";
import { boundedDataRead } from "../data-read-bounds";

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
  .get("/:id/items/:item/download", (c) =>
    withPublicReadTiming(
      c,
      "/public/galleries/:id/items/:item/download",
      "gallery_download_api",
      async () => {
        const record = await resolvePublicGallery(dbFor(c.env), c.req.param("id"));
        if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });

        // Soft-deleted / purged workspaces collapse to null — same uniform 404 as
        // missing tenants (matches public-files + authenticated paths). Check
        // before item lookup so existing and unknown item IDs both yield
        // gallery_not_found for unavailable workspaces (no item-existence oracle).
        const workspace = await loadWorkspaceRecord(c.env, record.workspace);
        if (!workspace) {
          throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
        }

        const items = await boundedDataRead(
          c,
          () => listGalleryItems(dbFor(c.env), record.workspace, record.id),
          { name: "d1_gallery_items" },
        );
        const item = items.find((entry) => entry.id === c.req.param("item"));
        if (!item) {
          throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
        }

        // Match gallery hydration: the active lane wins, then fallbacks are
        // searched in order. All subsequent gates and bytes use that same lane.
        const resolver = createLaneResolver(c.env, workspace);
        await withGalleryStorageErrors(() => resolver.activeConfig());
        const lane = await withGalleryStorageErrors(() => resolver.resolve(item.object_key));
        if (!lane) {
          throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
        }
        const { store, config } = lane;

        // Mirrors hydrateGalleryItems (gallery-service.ts): the object may have
        // been public at item-add time but the workspace's publicBaseUrl is
        // mutable afterward, or it may since have been marked private. Withhold
        // the bytes here exactly when the gallery's own read path would withhold
        // the item (uniform 404, never a distinct code), so this route can't be
        // used to bypass that gate.
        const [head, held] = await Promise.all([
          withGalleryStorageErrors(() => store.head(item.object_key)),
          isKeyHeld(c.env, record.workspace, item.object_key),
        ]);
        const headMeta = (head as { metadata?: Record<string, string> } | null)?.metadata;
        const hosted = isSharedLane(config);
        const row = hosted
          ? (await readVisibilityRows(dbFor(c.env), record.workspace, [item.object_key])).get(
              item.object_key,
            )
          : undefined;
        if (objectVisibility(applyVisibilityOverride(headMeta, hosted ? row : undefined))) {
          throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
        }
        // A held upload (`upload-hold.ts`) is withheld the same way.
        if (held) {
          throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
        }

        const urls = objectPublicUrls(c.env, config, item.object_key);
        if (!urls.url) {
          throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
        }

        return withGalleryStorageErrors(() => downloadResponse(store, item.object_key));
      },
    ),
  )
  .get("/:id", (c) =>
    withPublicReadTiming(c, "/public/galleries/:id", "gallery_api", async (measure) => {
      const record = await resolvePublicGallery(dbFor(c.env), c.req.param("id"));
      if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
      const workspace = await loadWorkspaceRecord(c.env, record.workspace);
      if (!workspace) {
        throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
      }
      const items = await boundedDataRead(
        c,
        () => listGalleryItems(dbFor(c.env), record.workspace, record.id),
        { name: "d1_gallery_items" },
      );
      const dto = await measure("hydrate", () =>
        hydratePublicGallery(c.env, workspace, record, items),
      );
      return c.json(dto);
    }),
  );
