import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { Hono, type Context } from "hono";
import { recordAdoptionSafe } from "../adoption";
import { badKey } from "../files-core";
import {
  addGalleryItem,
  addExternalReference,
  buildGallery,
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
  emptyOwnerGallery,
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
import { jsonBody } from "./json-body";
import { dbFor } from "../db-session";
import { primaryDbFor } from "../db-session";
import { boundedDataRead } from "../data-read-bounds";
import { createGalleryIdempotently } from "../gallery-idempotency";

async function ownerGallery(c: Context<WorkspaceVars>, id: string) {
  const record = await getGallery(dbFor(c.env), c.get("workspaceName"), id);
  if (!record) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const items = await listGalleryItems(dbFor(c.env), c.get("workspaceName"), id);
  return hydrateOwnerGallery(c.env, c.get("workspace"), record, items);
}

/**
 * Handler bodies (issue #613 phase 2): extracted to named functions so the
 * canonical dual-auth vertical (`routes/workspace-galleries.ts`) can reuse
 * them verbatim instead of copy-pasting — same "response shape can't drift"
 * guarantee `routes/workspace-files.ts` established for phase 1, just via a
 * shared handler reference rather than a `.fetch()` re-dispatch (galleries
 * has no cheap self-contained-router alias target the way files did, since
 * the bearer router here is mounted at a workspace-relative base path, not
 * `/:workspace/galleries*`).
 */
export async function createGalleryHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const input = {
    workspace: c.get("workspaceName"),
    title: typeof body.title === "string" ? body.title : "",
    description:
      body.description === null || typeof body.description === "string"
        ? body.description
        : undefined,
  };
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey === undefined) {
    const result = unwrapMutation(await createGallery(dbFor(c.env), input));
    await recordAdoptionSafe(c.env, {
      metric: "gallery_created",
      workspace: c.get("workspaceName"),
    });
    return c.json(await ownerGallery(c, result.value.id), 201);
  }

  const record = unwrapMutation(buildGallery(input)).value;
  const response = emptyOwnerGallery(c.env, record);
  let result;
  try {
    result = await createGalleryIdempotently(primaryDbFor(c.env), {
      workspace: c.get("workspaceName"),
      principal: c.get("authPrincipal"),
      key: idempotencyKey,
      record,
      response,
    });
  } catch (error) {
    if (error instanceof ConflictError && error.code === "idempotency_request_in_progress") {
      c.header("Retry-After", "1");
    }
    throw error;
  }
  if (result.status === "limit") mutationError(result);
  if (result.replayed) c.header("Idempotency-Replayed", "true");
  if (!result.replayed) {
    await recordAdoptionSafe(c.env, {
      metric: "gallery_created",
      workspace: c.get("workspaceName"),
    });
  }
  return c.json(result.value, 201);
}

export async function listGalleriesHandler(c: Context<WorkspaceVars>) {
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("limit must be an integer from 1 to 100.");
  const page = await boundedDataRead(
    c,
    () =>
      listGalleries(dbFor(c.env), c.get("workspaceName"), {
        limit,
        cursor: decodeGalleryCursor(c.req.query("cursor")),
      }),
    { name: "d1_galleries_list" },
  );
  const result = page.galleries.map((gallery) => gallerySummary(c.env, gallery));
  return c.json({
    galleries: result,
    nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
  });
}

export async function galleriesByReferenceHandler(c: Context<WorkspaceVars>) {
  const parsed = parseExternalReference(c.req.query("provider"), c.req.query("coordinate"));
  if (!parsed.ok) throw new ValidationError(parsed.message, { code: "gallery_invalid_reference" });
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("limit must be an integer from 1 to 100.");
  const page = await boundedDataRead(
    c,
    () =>
      findGalleriesByReference(dbFor(c.env), c.get("workspaceName"), parsed.value.normalizedKey, {
        limit,
        cursor: decodeGalleryCursor(c.req.query("cursor")),
      }),
    { name: "d1_galleries_by_reference" },
  );
  return c.json({
    galleries: page.galleries.map((gallery) => gallerySummary(c.env, gallery)),
    nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
  });
}

export async function getGalleryHandler(c: Context<WorkspaceVars>) {
  const id = c.req.param("id") as string;
  return c.json(await boundedDataRead(c, () => ownerGallery(c, id), { name: "d1_gallery_get" }));
}

export async function updateGalleryHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const { value } = unwrapMutation(
    await updateGallery(dbFor(c.env), c.get("workspaceName"), c.req.param("id") as string, {
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
}

export async function deleteGalleryHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const result = await softDeleteGallery(
    dbFor(c.env),
    c.get("workspaceName"),
    c.req.param("id") as string,
    requireExpectedVersion(body.expectedVersion),
  );
  if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
  return c.json({ deleted: true, id: c.req.param("id") as string });
}

export async function addGalleryItemHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const key = typeof body.objectKey === "string" ? body.objectKey : "";
  if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
  const galleryId = c.req.param("id") as string;
  const gallery = await getGallery(dbFor(c.env), c.get("workspaceName"), galleryId);
  if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const expectedVersion = requireExpectedVersion(body.expectedVersion);
  const existing = (await listGalleryItems(dbFor(c.env), c.get("workspaceName"), galleryId)).find(
    (item) => item.object_key === key,
  );
  if (existing) {
    const item = (await ownerGallery(c, galleryId)).items.find((entry) => entry.id === existing.id);
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
    await addGalleryItem(dbFor(c.env), c.get("workspaceName"), c.req.param("id") as string, {
      expectedVersion,
      objectKey: key,
      caption: body.caption === null || typeof body.caption === "string" ? body.caption : undefined,
      altText: body.altText === null || typeof body.altText === "string" ? body.altText : undefined,
    }),
  );
  const item = (await ownerGallery(c, c.req.param("id") as string)).items.find(
    (entry) => entry.id === result.value.id,
  );
  if (!item) throw new NotFoundError("Gallery item not found.");
  return c.json(item, result.unchanged ? 200 : 201);
}

export async function reorderGalleryItemsHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  if (!Array.isArray(body.itemIds) || !body.itemIds.every((id) => typeof id === "string"))
    throw new ValidationError("itemIds must be an array of strings.");
  const result = unwrapMutation(
    await reorderGalleryItems(
      dbFor(c.env),
      c.get("workspaceName"),
      c.req.param("id") as string,
      body.itemIds,
      requireExpectedVersion(body.expectedVersion),
    ),
  );
  return c.json({
    items: (await ownerGallery(c, c.req.param("id") as string)).items,
    unchanged: result.unchanged,
  });
}

export async function removeGalleryItemHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const result = await removeGalleryItem(
    dbFor(c.env),
    c.get("workspaceName"),
    c.req.param("id") as string,
    c.req.param("itemId") as string,
    requireExpectedVersion(body.expectedVersion),
  );
  if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
  return c.json({ deleted: true, id: c.req.param("itemId") as string });
}

export async function listExternalReferencesHandler(c: Context<WorkspaceVars>) {
  const references = await boundedDataRead(
    c,
    async () => {
      const gallery = await getGallery(
        dbFor(c.env),
        c.get("workspaceName"),
        c.req.param("id") as string,
      );
      if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
      return listExternalReferences(dbFor(c.env), c.get("workspaceName"), gallery.id);
    },
    { name: "d1_gallery_external_references" },
  );
  return c.json({ references: references.map(referenceDto) });
}

export async function addExternalReferenceHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const gallery = await getGallery(
    dbFor(c.env),
    c.get("workspaceName"),
    c.req.param("id") as string,
  );
  if (!gallery) throw new NotFoundError("Gallery not found.", { code: "gallery_not_found" });
  const parsed = parseExternalReference(body.provider, body.coordinate);
  if (!parsed.ok) throw new ValidationError(parsed.message, { code: "gallery_invalid_reference" });
  const result = unwrapMutation(
    await addExternalReference(dbFor(c.env), c.get("workspaceName"), c.req.param("id") as string, {
      expectedVersion: requireExpectedVersion(body.expectedVersion),
      ...parsed.value,
    }),
  );
  return c.json(referenceDto(result.value), result.unchanged ? 200 : 201);
}

export async function removeExternalReferenceHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const result = await removeExternalReference(
    dbFor(c.env),
    c.get("workspaceName"),
    c.req.param("id") as string,
    c.req.param("referenceId") as string,
    requireExpectedVersion(body.expectedVersion),
  );
  if (result.status !== "ok" && result.status !== "unchanged") mutationError(result);
  return c.json({ deleted: true, id: c.req.param("referenceId") as string });
}

export const galleries = new Hono<WorkspaceVars>()
  .post("/", writeRateLimit, requireScope("files:write"), createGalleryHandler)
  .get("/", requireScope("files:read"), listGalleriesHandler)
  .get("/by-reference", requireScope("files:read"), galleriesByReferenceHandler)
  .get("/:id", requireScope("files:read"), getGalleryHandler)
  .patch("/:id", writeRateLimit, requireScope("files:write"), updateGalleryHandler)
  .delete("/:id", writeRateLimit, requireScope("files:write"), deleteGalleryHandler)
  .post("/:id/items", writeRateLimit, requireScope("files:write"), addGalleryItemHandler)
  .put("/:id/items/order", writeRateLimit, requireScope("files:write"), reorderGalleryItemsHandler)
  .delete(
    "/:id/items/:itemId",
    writeRateLimit,
    requireScope("files:write"),
    removeGalleryItemHandler,
  )
  .get("/:id/external-references", requireScope("files:read"), listExternalReferencesHandler)
  .post(
    "/:id/external-references",
    writeRateLimit,
    requireScope("files:write"),
    addExternalReferenceHandler,
  )
  .delete(
    "/:id/external-references/:referenceId",
    writeRateLimit,
    requireScope("files:write"),
    removeExternalReferenceHandler,
  );
