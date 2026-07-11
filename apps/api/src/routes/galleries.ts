import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { Hono, type Context } from "hono";
import { badKey } from "../files-core";
import {
  addGalleryItem,
  addExternalReference,
  createGallery,
  getGallery,
  listGalleries,
  listGalleryItems,
  listExternalReferences,
  findGalleriesByReference,
  removeGalleryItem,
  removeExternalReference,
  reorderGalleryItems,
  softDeleteGallery,
  updateGallery,
} from "../galleries";
import {
  decodeGalleryCursor,
  encodeGalleryCursor,
  gallerySummary,
  hydrateOwnerGallery,
  mutationError,
  requireExpectedVersion,
  referenceDto,
  unwrapMutation,
} from "../gallery-service";
import { writeRateLimit } from "../guards";
import { parseExternalReference } from "../external-references";
import { publicUrl, storage, storageConfig } from "../storage";
import { requireScope, type WorkspaceVars } from "../workspace";

async function jsonBody(c: Context<WorkspaceVars>): Promise<Record<string, unknown>> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new ValidationError("Expected a JSON object.");
  return body as Record<string, unknown>;
}

async function ownerGallery(c: Context<WorkspaceVars>, id: string) {
  const record = await getGallery(c.env.DB, c.get("workspaceName"), id);
  if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const items = await listGalleryItems(c.env.DB, c.get("workspaceName"), id);
  return hydrateOwnerGallery(c.env, c.get("workspace"), record, items);
}

export const galleries = new Hono<WorkspaceVars>()
  .post("/", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const result = unwrapMutation(
      await createGallery(c.env.DB, {
        workspace: c.get("workspaceName"),
        title: typeof body.title === "string" ? body.title : "",
        description:
          body.description === null || typeof body.description === "string"
            ? body.description
            : undefined,
      }),
    );
    return c.json(await ownerGallery(c, result.value.id), 201);
  })
  .get("/", requireScope("files:read"), async (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ValidationError("limit must be an integer from 1 to 100.");
    const page = await listGalleries(c.env.DB, c.get("workspaceName"), {
      limit,
      cursor: decodeGalleryCursor(c.req.query("cursor")),
    });
    const result = page.galleries.map(gallerySummary);
    return c.json({
      galleries: result,
      nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
    });
  })
  .get("/by-reference", requireScope("files:read"), async (c) => {
    const parsed = parseExternalReference(c.req.query("provider"), c.req.query("coordinate"));
    if (!parsed.ok)
      throw new ValidationError(parsed.message, { code: "gallery_invalid_reference" });
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ValidationError("limit must be an integer from 1 to 100.");
    const page = await findGalleriesByReference(
      c.env.DB,
      c.get("workspaceName"),
      parsed.value.normalizedKey,
      { limit, cursor: decodeGalleryCursor(c.req.query("cursor")) },
    );
    return c.json({
      galleries: page.galleries.map(gallerySummary),
      nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
    });
  })
  .get("/:id", requireScope("files:read"), async (c) =>
    c.json(await ownerGallery(c, c.req.param("id"))),
  )
  .patch("/:id", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const { value } = unwrapMutation(
      await updateGallery(c.env.DB, c.get("workspaceName"), c.req.param("id"), {
        expectedVersion: requireExpectedVersion(body.expectedVersion),
        title: typeof body.title === "string" ? body.title : undefined,
        description:
          body.description === null || typeof body.description === "string"
            ? body.description
            : undefined,
        coverItemId:
          body.coverItemId === null || typeof body.coverItemId === "string"
            ? body.coverItemId
            : undefined,
      }),
    );
    return c.json(await ownerGallery(c, value.id));
  })
  .delete("/:id", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const result = await softDeleteGallery(
      c.env.DB,
      c.get("workspaceName"),
      c.req.param("id"),
      requireExpectedVersion(body.expectedVersion),
    );
    if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
    return c.json({ deleted: true, id: c.req.param("id") });
  })
  .post("/:id/items", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const key = typeof body.objectKey === "string" ? body.objectKey : "";
    if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
    const galleryId = c.req.param("id");
    const gallery = await getGallery(c.env.DB, c.get("workspaceName"), galleryId);
    if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const expectedVersion = requireExpectedVersion(body.expectedVersion);
    const existing = (await listGalleryItems(c.env.DB, c.get("workspaceName"), galleryId)).find(
      (item) => item.object_key === key,
    );
    if (existing) {
      const item = (await ownerGallery(c, galleryId)).items.find(
        (entry) => entry.id === existing.id,
      );
      if (!item)
        throw new NotFoundError("Gallery item not found.", { code: "gallery_item_not_found" });
      return c.json(item, 200);
    }
    if (gallery.version !== expectedVersion)
      throw new ConflictError("Gallery was changed by another request.", {
        code: "gallery_version_conflict",
        details: { currentVersion: gallery.version },
      });
    const ws = c.get("workspace");
    let store: Awaited<ReturnType<typeof storage>>;
    let config: Awaited<ReturnType<typeof storageConfig>>;
    try {
      [store, config] = await Promise.all([storage(c.env, ws), storageConfig(c.env, ws)]);
    } catch (cause) {
      throw new ServiceUnavailableError("Gallery storage unavailable.", {
        code: "gallery_storage_unavailable",
        cause,
      });
    }
    let exists: boolean;
    try {
      exists = await store.exists(key);
    } catch (cause) {
      throw new ServiceUnavailableError("Gallery storage unavailable.", {
        code: "gallery_storage_unavailable",
        cause,
      });
    }
    if (!exists) throw new NotFoundError("Object not found.", { code: "gallery_object_not_found" });
    if (publicUrl(config, key) === null)
      throw new ValidationError("Object has no public URL.", { code: "gallery_object_not_public" });
    const result = unwrapMutation(
      await addGalleryItem(c.env.DB, c.get("workspaceName"), c.req.param("id"), {
        expectedVersion,
        objectKey: key,
        caption:
          body.caption === null || typeof body.caption === "string" ? body.caption : undefined,
        altText:
          body.altText === null || typeof body.altText === "string" ? body.altText : undefined,
      }),
    );
    const item = (await ownerGallery(c, c.req.param("id"))).items.find(
      (entry) => entry.id === result.value.id,
    );
    if (!item) throw new NotFoundError("Gallery item not found.");
    return c.json(item, result.unchanged ? 200 : 201);
  })
  .put("/:id/items/order", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    if (!Array.isArray(body.itemIds) || !body.itemIds.every((id) => typeof id === "string"))
      throw new ValidationError("itemIds must be an array of strings.");
    const result = unwrapMutation(
      await reorderGalleryItems(
        c.env.DB,
        c.get("workspaceName"),
        c.req.param("id"),
        body.itemIds,
        requireExpectedVersion(body.expectedVersion),
      ),
    );
    return c.json({
      items: (await ownerGallery(c, c.req.param("id"))).items,
      unchanged: result.unchanged,
    });
  })
  .delete("/:id/items/:itemId", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const result = await removeGalleryItem(
      c.env.DB,
      c.get("workspaceName"),
      c.req.param("id"),
      c.req.param("itemId"),
      requireExpectedVersion(body.expectedVersion),
    );
    if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
    return c.json({ deleted: true, id: c.req.param("itemId") });
  })
  .get("/:id/external-references", requireScope("files:read"), async (c) => {
    const gallery = await getGallery(c.env.DB, c.get("workspaceName"), c.req.param("id"));
    if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    return c.json({
      references: (await listExternalReferences(c.env.DB, c.get("workspaceName"), gallery.id)).map(
        referenceDto,
      ),
    });
  })
  .post("/:id/external-references", writeRateLimit, requireScope("files:write"), async (c) => {
    const body = await jsonBody(c);
    const gallery = await getGallery(c.env.DB, c.get("workspaceName"), c.req.param("id"));
    if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
    const parsed = parseExternalReference(body.provider, body.coordinate);
    if (!parsed.ok)
      throw new ValidationError(parsed.message, { code: "gallery_invalid_reference" });
    const result = unwrapMutation(
      await addExternalReference(c.env.DB, c.get("workspaceName"), c.req.param("id"), {
        expectedVersion: requireExpectedVersion(body.expectedVersion),
        ...parsed.value,
      }),
    );
    return c.json(referenceDto(result.value), result.unchanged ? 200 : 201);
  })
  .delete(
    "/:id/external-references/:referenceId",
    writeRateLimit,
    requireScope("files:write"),
    async (c) => {
      const body = await jsonBody(c);
      const result = await removeExternalReference(
        c.env.DB,
        c.get("workspaceName"),
        c.req.param("id"),
        c.req.param("referenceId"),
        requireExpectedVersion(body.expectedVersion),
      );
      if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
      return c.json({ deleted: true, id: c.req.param("referenceId") });
    },
  );
