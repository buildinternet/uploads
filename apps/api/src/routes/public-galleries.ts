import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { listGalleryItems, resolvePublicGallery } from "../galleries";
import { hydratePublicGallery } from "../gallery-service";
import { type WorkspaceRecord, type WorkspaceVars } from "../workspace";

export const publicGalleries = new Hono<WorkspaceVars>().get("/:id", async (c) => {
  const record = await resolvePublicGallery(c.env.DB, c.req.param("id"));
  if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const workspace = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${record.workspace}`, {
    type: "json",
    cacheTtl: 60,
  });
  if (!workspace) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const items = await listGalleryItems(c.env.DB, record.workspace, record.id);
  return c.json(await hydratePublicGallery(c.env, workspace, record, items));
});
