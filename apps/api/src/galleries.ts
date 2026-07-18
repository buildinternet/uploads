/** Per-workspace cap; gallery membership remains independently capped below. */
export const MAX_GALLERIES_PER_WORKSPACE = 100;
export const MAX_GALLERY_ITEMS = 100;
export const MAX_GALLERY_REFERENCES = 20;
export const MAX_GALLERY_PAGE_SIZE = 100;

export function clampGalleryPageLimit(requestedLimit: number | undefined): number {
  const limit = requestedLimit ?? 50;
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_GALLERY_PAGE_SIZE, Math.floor(limit)))
    : 50;
}

export interface GalleryRecord {
  id: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  cover_item_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface GalleryItemRecord {
  id: string;
  gallery_id: string;
  object_key: string;
  position: number;
  caption: string | null;
  alt_text: string | null;
  created_at: string;
}

export interface GalleryExternalReferenceRecord {
  id: string;
  gallery_id: string;
  provider: string;
  resource_type: string;
  normalized_key: string;
  locator_json: string;
  canonical_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicGallery {
  id: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type MutationResult<T = undefined> =
  | { status: "ok"; value: T }
  | { status: "unchanged"; value: T }
  | { status: "not_found"; entity: "gallery" | "item" | "reference" }
  | { status: "conflict"; currentVersion: number }
  | { status: "limit"; limit: number }
  | { status: "invalid"; field: string; message: string };

export interface GalleryCursor {
  createdAt: string;
  id: string;
}

export interface GalleryPage {
  galleries: GalleryRecord[];
  nextCursor: GalleryCursor | null;
}

const encoder = new TextEncoder();
function hasUnsafePlainText(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f) ||
      /\p{Cf}/u.test(character)
    );
  });
}

function invalid(field: string, message: string): MutationResult<never> {
  return { status: "invalid", field, message };
}

function plainText(
  value: string | null | undefined,
  field: string,
  maxBytes: number,
): MutationResult<never> | null {
  if (value == null) return null;
  if (hasUnsafePlainText(value)) return invalid(field, "must contain safe plain text");
  if (encoder.encode(value).byteLength > maxBytes)
    return invalid(field, `must be at most ${maxBytes} UTF-8 bytes`);
  return null;
}

function validateTitle(title: string): MutationResult<never> | null {
  const length = Array.from(title.trim()).length;
  if (length < 1 || length > 120) return invalid("title", "must be between 1 and 120 characters");
  return plainText(title, "title", 480);
}

function randomGalleryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `gal_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

async function classifyVersion(
  db: D1Database,
  workspace: string,
  id: string,
  expectedVersion: number,
  missingEntity: "gallery" | "item" | "reference" = "gallery",
): Promise<MutationResult<never>> {
  const current = await getGallery(db, workspace, id);
  if (!current) return { status: "not_found", entity: "gallery" };
  if (current.version === expectedVersion) return { status: "not_found", entity: missingEntity };
  return { status: "conflict", currentVersion: current.version };
}

export async function createGallery(
  db: D1Database,
  input: { workspace: string; title: string; description?: string | null; now?: Date },
): Promise<MutationResult<GalleryRecord>> {
  const titleError = validateTitle(input.title);
  if (titleError) return titleError;
  const descriptionError = plainText(input.description, "description", 2000);
  if (descriptionError) return descriptionError;
  const now = (input.now ?? new Date()).toISOString();
  const record: GalleryRecord = {
    id: randomGalleryId(),
    workspace: input.workspace,
    title: input.title.trim(),
    description: input.description ?? null,
    visibility: "public",
    cover_item_id: null,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  // The count check lives in the INSERT so concurrent creates cannot exceed the
  // tenant quota. Soft-deleted galleries deliberately do not consume a slot.
  const result = await db
    .prepare(
      `INSERT INTO galleries
      (id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at)
     SELECT ?, ?, ?, ?, 'public', NULL, 1, ?, ?, NULL
     WHERE (SELECT COUNT(*) FROM galleries WHERE workspace = ? AND deleted_at IS NULL) < ?`,
    )
    .bind(
      record.id,
      record.workspace,
      record.title,
      record.description,
      now,
      now,
      record.workspace,
      MAX_GALLERIES_PER_WORKSPACE,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return { status: "limit", limit: MAX_GALLERIES_PER_WORKSPACE };
  }
  return { status: "ok", value: record };
}

export async function getGallery(
  db: D1Database,
  workspace: string,
  id: string,
): Promise<GalleryRecord | null> {
  return db
    .prepare(
      `SELECT id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at
     FROM galleries WHERE id = ? AND workspace = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(id, workspace)
    .first<GalleryRecord>();
}

/** Internal resolver. Do not return this record from a public route; use projectPublicGallery. */
export async function resolvePublicGallery(
  db: D1Database,
  id: string,
): Promise<GalleryRecord | null> {
  return db
    .prepare(
      `SELECT id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at
     FROM galleries WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(id)
    .first<GalleryRecord>();
}

export function projectPublicGallery(record: GalleryRecord): PublicGallery {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    visibility: record.visibility,
    coverItemId: record.cover_item_id,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function listGalleries(
  db: D1Database,
  workspace: string,
  options: { limit?: number; cursor?: GalleryCursor } = {},
): Promise<GalleryPage> {
  const limit = clampGalleryPageLimit(options.limit);
  const cursor = options.cursor;
  const result = cursor
    ? await db
        .prepare(
          `SELECT id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at
       FROM galleries WHERE workspace = ? AND deleted_at IS NULL
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(workspace, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
        .all<GalleryRecord>()
    : await db
        .prepare(
          `SELECT id, workspace, title, description, visibility, cover_item_id, version, created_at, updated_at, deleted_at
       FROM galleries WHERE workspace = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(workspace, limit + 1)
        .all<GalleryRecord>();
  const galleries = result.results.slice(0, limit);
  const last = galleries.at(-1);
  return {
    galleries,
    nextCursor:
      result.results.length > limit && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export async function updateGallery(
  db: D1Database,
  workspace: string,
  id: string,
  input: {
    expectedVersion: number;
    title?: string;
    description?: string | null;
    coverItemId?: string | null;
    now?: Date;
  },
): Promise<MutationResult<GalleryRecord>> {
  if (input.title !== undefined) {
    const error = validateTitle(input.title);
    if (error) return error;
  }
  const descriptionError = plainText(input.description, "description", 2000);
  if (descriptionError) return descriptionError;
  const current = await getGallery(db, workspace, id);
  if (!current) return { status: "not_found", entity: "gallery" };
  if (current.version !== input.expectedVersion)
    return { status: "conflict", currentVersion: current.version };
  const title = input.title?.trim() ?? current.title;
  const description = input.description === undefined ? current.description : input.description;
  const cover = input.coverItemId === undefined ? current.cover_item_id : input.coverItemId;
  if (
    title === current.title &&
    description === current.description &&
    cover === current.cover_item_id
  )
    return { status: "unchanged", value: current };
  const iso = (input.now ?? new Date()).toISOString();
  const changed = await db
    .prepare(
      `UPDATE galleries SET title = ?, description = ?, cover_item_id = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
       AND (? IS NULL OR EXISTS (SELECT 1 FROM gallery_items i WHERE i.id = ? AND i.gallery_id = galleries.id))`,
    )
    .bind(title, description, cover, iso, id, workspace, input.expectedVersion, cover, cover)
    .run();
  if (changed.meta.changes !== 1) {
    const after = await getGallery(db, workspace, id);
    if (after?.version === input.expectedVersion && cover !== null) {
      return invalid("coverItemId", "must identify an item in this gallery");
    }
    return after
      ? { status: "conflict", currentVersion: after.version }
      : { status: "not_found", entity: "gallery" };
  }
  return {
    status: "ok",
    value: {
      ...current,
      title,
      description,
      cover_item_id: cover,
      version: current.version + 1,
      updated_at: iso,
    },
  };
}

/**
 * Hard-deletes every gallery (and its items/external references) for a
 * workspace being torn down. Unlike `softDeleteGallery`, this is a permanent,
 * unversioned wipe — only for workspace deletion, never a member-facing
 * route. Explicit child deletes first rather than relying on the schema's
 * `ON DELETE CASCADE` so this stays correct even if D1's FK enforcement
 * config ever changes.
 */
export async function deleteGalleriesForWorkspace(
  db: D1Database,
  workspace: string,
): Promise<{ galleries: number }> {
  await db
    .prepare(
      `DELETE FROM gallery_items WHERE gallery_id IN (SELECT id FROM galleries WHERE workspace = ?)`,
    )
    .bind(workspace)
    .run();
  await db
    .prepare(
      `DELETE FROM gallery_external_references WHERE gallery_id IN (SELECT id FROM galleries WHERE workspace = ?)`,
    )
    .bind(workspace)
    .run();
  const result = await db
    .prepare(`DELETE FROM galleries WHERE workspace = ?`)
    .bind(workspace)
    .run();
  return { galleries: result.meta.changes ?? 0 };
}

export async function softDeleteGallery(
  db: D1Database,
  workspace: string,
  id: string,
  expectedVersion: number,
  now = new Date(),
): Promise<MutationResult> {
  const iso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE galleries SET deleted_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?`,
    )
    .bind(iso, iso, id, workspace, expectedVersion)
    .run();
  return result.meta.changes === 1
    ? { status: "ok", value: undefined }
    : classifyVersion(db, workspace, id, expectedVersion);
}

export async function listGalleryItems(
  db: D1Database,
  workspace: string,
  galleryId: string,
): Promise<GalleryItemRecord[]> {
  const result = await db
    .prepare(
      `SELECT i.id, i.gallery_id, i.object_key, i.position, i.caption, i.alt_text, i.created_at
     FROM gallery_items i JOIN galleries g ON g.id = i.gallery_id
     WHERE i.gallery_id = ? AND g.workspace = ? AND g.deleted_at IS NULL ORDER BY i.position, i.id`,
    )
    .bind(galleryId, workspace)
    .all<GalleryItemRecord>();
  return result.results;
}

/** Persistence primitive: callers must first verify objectKey exists and has a public URL. */
export async function addGalleryItem(
  db: D1Database,
  workspace: string,
  galleryId: string,
  input: {
    expectedVersion: number;
    objectKey: string;
    caption?: string | null;
    altText?: string | null;
    now?: Date;
  },
): Promise<MutationResult<GalleryItemRecord>> {
  if (!input.objectKey || encoder.encode(input.objectKey).byteLength > 1024)
    return invalid("objectKey", "must be between 1 and 1024 UTF-8 bytes");
  const captionError = plainText(input.caption, "caption", 500);
  if (captionError) return captionError;
  const altError = plainText(input.altText, "altText", 300);
  if (altError) return altError;
  const existing = (await listGalleryItems(db, workspace, galleryId)).find(
    (item) => item.object_key === input.objectKey,
  );
  if (existing) return { status: "unchanged", value: existing };
  const current = await getGallery(db, workspace, galleryId);
  if (!current) return { status: "not_found", entity: "gallery" };
  if (current.version !== input.expectedVersion)
    return { status: "conflict", currentVersion: current.version };
  const iso = (input.now ?? new Date()).toISOString();
  const id = crypto.randomUUID();
  const [inserted, updated] = await db.batch([
    db
      .prepare(
        `INSERT INTO gallery_items (id, gallery_id, object_key, position, caption, alt_text, created_at)
       SELECT ?, g.id, ?, COALESCE(MAX(i.position), 0) + 1000, ?, ?, ?
       FROM galleries g LEFT JOIN gallery_items i ON i.gallery_id = g.id
       WHERE g.id = ? AND g.workspace = ? AND g.deleted_at IS NULL AND g.version = ?
         AND NOT EXISTS (SELECT 1 FROM gallery_items d WHERE d.gallery_id = g.id AND d.object_key = ?)
       GROUP BY g.id HAVING COUNT(i.id) < ?`,
      )
      .bind(
        id,
        input.objectKey,
        input.caption ?? null,
        input.altText ?? null,
        iso,
        galleryId,
        workspace,
        input.expectedVersion,
        input.objectKey,
        MAX_GALLERY_ITEMS,
      ),
    db
      .prepare(
        `UPDATE galleries SET version = version + 1, updated_at = ?
       WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
         AND EXISTS (SELECT 1 FROM gallery_items i WHERE i.id = ? AND i.gallery_id = galleries.id)`,
      )
      .bind(iso, galleryId, workspace, input.expectedVersion, id),
  ]);
  if (inserted.meta.changes === 1 && updated.meta.changes === 1) {
    const item = (await listGalleryItems(db, workspace, galleryId)).find(
      (entry) => entry.id === id,
    );
    if (item) return { status: "ok", value: item };
  }
  const after = await getGallery(db, workspace, galleryId);
  const duplicate = (await listGalleryItems(db, workspace, galleryId)).find(
    (item) => item.object_key === input.objectKey,
  );
  if (duplicate) return { status: "unchanged", value: duplicate };
  if (!after) return { status: "not_found", entity: "gallery" };
  if (after.version !== input.expectedVersion)
    return { status: "conflict", currentVersion: after.version };
  const count = (await listGalleryItems(db, workspace, galleryId)).length;
  return count >= MAX_GALLERY_ITEMS
    ? { status: "limit", limit: MAX_GALLERY_ITEMS }
    : { status: "conflict", currentVersion: after.version };
}

export async function removeGalleryItem(
  db: D1Database,
  workspace: string,
  galleryId: string,
  itemId: string,
  expectedVersion: number,
  now = new Date(),
): Promise<MutationResult> {
  const iso = now.toISOString();
  const [updated, removed] = await db.batch([
    db
      .prepare(
        `UPDATE galleries SET cover_item_id = CASE WHEN cover_item_id = ? THEN NULL ELSE cover_item_id END,
       version = version + 1, updated_at = ?
       WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
         AND EXISTS (SELECT 1 FROM gallery_items i WHERE i.id = ? AND i.gallery_id = galleries.id)`,
      )
      .bind(itemId, iso, galleryId, workspace, expectedVersion, itemId),
    db
      .prepare(
        `DELETE FROM gallery_items WHERE id = ? AND gallery_id = ? AND EXISTS
       (SELECT 1 FROM galleries g WHERE g.id = gallery_id AND g.workspace = ? AND g.version = ? + 1)`,
      )
      .bind(itemId, galleryId, workspace, expectedVersion),
  ]);
  if (updated.meta.changes === 1 && removed.meta.changes === 1)
    return { status: "ok", value: undefined };
  return classifyVersion(db, workspace, galleryId, expectedVersion, "item");
}

export async function reorderGalleryItems(
  db: D1Database,
  workspace: string,
  galleryId: string,
  orderedItemIds: string[],
  expectedVersion: number,
  now = new Date(),
): Promise<MutationResult<GalleryItemRecord[]>> {
  if (
    orderedItemIds.length > MAX_GALLERY_ITEMS ||
    new Set(orderedItemIds).size !== orderedItemIds.length
  )
    return invalid("itemIds", "must be a complete list of distinct item IDs");
  const current = await getGallery(db, workspace, galleryId);
  if (!current) return { status: "not_found", entity: "gallery" };
  if (current.version !== expectedVersion)
    return { status: "conflict", currentVersion: current.version };
  const existing = await listGalleryItems(db, workspace, galleryId);
  if (
    existing.length !== orderedItemIds.length ||
    existing.some((item) => !orderedItemIds.includes(item.id))
  )
    return invalid("itemIds", "must contain every current item exactly once");
  if (existing.every((item, index) => item.id === orderedItemIds[index]))
    return { status: "unchanged", value: existing };
  const iso = now.toISOString();
  const placeholders = orderedItemIds.map(() => "?").join(", ") || "NULL";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE galleries SET version = version + 1, updated_at = ?
     WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
       AND (SELECT COUNT(*) FROM gallery_items i WHERE i.gallery_id = galleries.id) = ?
       AND (SELECT COUNT(*) FROM gallery_items i WHERE i.gallery_id = galleries.id AND i.id IN (${placeholders})) = ?`,
      )
      .bind(
        iso,
        galleryId,
        workspace,
        expectedVersion,
        orderedItemIds.length,
        ...orderedItemIds,
        orderedItemIds.length,
      ),
  ];
  statements.push(
    ...orderedItemIds.map((itemId, index) =>
      db
        .prepare(
          `UPDATE gallery_items SET position = ? WHERE id = ? AND gallery_id = ? AND EXISTS
     (SELECT 1 FROM galleries g WHERE g.id = gallery_id AND g.workspace = ? AND g.deleted_at IS NULL AND g.version = ? + 1)`,
        )
        .bind((index + 1) * 1000, itemId, galleryId, workspace, expectedVersion),
    ),
  );
  const results = await db.batch(statements);
  if (results.every((result) => result.meta.changes === 1))
    return { status: "ok", value: await listGalleryItems(db, workspace, galleryId) };
  return classifyVersion(db, workspace, galleryId, expectedVersion);
}

export async function listExternalReferences(
  db: D1Database,
  workspace: string,
  galleryId: string,
): Promise<GalleryExternalReferenceRecord[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.gallery_id, r.provider, r.resource_type, r.normalized_key, r.locator_json,
            r.canonical_url, r.created_at, r.updated_at
     FROM gallery_external_references r JOIN galleries g ON g.id = r.gallery_id
     WHERE r.gallery_id = ? AND g.workspace = ? AND g.deleted_at IS NULL ORDER BY r.created_at, r.id`,
    )
    .bind(galleryId, workspace)
    .all<GalleryExternalReferenceRecord>();
  return result.results;
}

export async function addExternalReference(
  db: D1Database,
  workspace: string,
  galleryId: string,
  input: {
    expectedVersion: number;
    provider: string;
    resourceType: string;
    normalizedKey: string;
    locator: unknown;
    canonicalUrl?: string | null;
    now?: Date;
  },
): Promise<MutationResult<GalleryExternalReferenceRecord>> {
  for (const [field, value, max] of [
    ["provider", input.provider, 64],
    ["resourceType", input.resourceType, 64],
    ["normalizedKey", input.normalizedKey, 512],
  ] as const) {
    if (!value || encoder.encode(value).byteLength > max || hasUnsafePlainText(value))
      return invalid(field, `must be safe plain text between 1 and ${max} UTF-8 bytes`);
  }
  if (input.canonicalUrl != null) {
    const urlError = plainText(input.canonicalUrl, "canonicalUrl", 2048);
    if (urlError) return urlError;
    try {
      const url = new URL(input.canonicalUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return invalid("canonicalUrl", "must use http or https");
      }
    } catch {
      return invalid("canonicalUrl", "must be an absolute http or https URL");
    }
  }
  if (input.locator === null || typeof input.locator !== "object" || Array.isArray(input.locator)) {
    return invalid("locator", "must be a JSON object");
  }
  let locatorJson: string;
  try {
    locatorJson = JSON.stringify(input.locator);
  } catch {
    return invalid("locator", "must be JSON serializable");
  }
  if (!locatorJson || encoder.encode(locatorJson).byteLength > 8192)
    return invalid("locator", "must be at most 8192 UTF-8 bytes when encoded");
  const existing = (await listExternalReferences(db, workspace, galleryId)).find(
    (reference) => reference.normalized_key === input.normalizedKey,
  );
  if (existing) return { status: "unchanged", value: existing };
  const current = await getGallery(db, workspace, galleryId);
  if (!current) return { status: "not_found", entity: "gallery" };
  if (current.version !== input.expectedVersion)
    return { status: "conflict", currentVersion: current.version };
  const iso = (input.now ?? new Date()).toISOString();
  const id = crypto.randomUUID();
  const [inserted, updated] = await db.batch([
    db
      .prepare(
        `INSERT INTO gallery_external_references
       (id, gallery_id, provider, resource_type, normalized_key, locator_json, canonical_url, created_at, updated_at)
       SELECT ?, g.id, ?, ?, ?, ?, ?, ?, ? FROM galleries g
       WHERE g.id = ? AND g.workspace = ? AND g.deleted_at IS NULL AND g.version = ?
         AND NOT EXISTS (SELECT 1 FROM gallery_external_references d WHERE d.gallery_id = g.id AND d.normalized_key = ?)
         AND (SELECT COUNT(*) FROM gallery_external_references r WHERE r.gallery_id = g.id) < ?`,
      )
      .bind(
        id,
        input.provider,
        input.resourceType,
        input.normalizedKey,
        locatorJson,
        input.canonicalUrl ?? null,
        iso,
        iso,
        galleryId,
        workspace,
        input.expectedVersion,
        input.normalizedKey,
        MAX_GALLERY_REFERENCES,
      ),
    db
      .prepare(
        `UPDATE galleries SET version = version + 1, updated_at = ?
       WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
         AND EXISTS (SELECT 1 FROM gallery_external_references r WHERE r.id = ? AND r.gallery_id = galleries.id)`,
      )
      .bind(iso, galleryId, workspace, input.expectedVersion, id),
  ]);
  if (inserted.meta.changes === 1 && updated.meta.changes === 1) {
    const record = (await listExternalReferences(db, workspace, galleryId)).find(
      (reference) => reference.id === id,
    );
    if (record) return { status: "ok", value: record };
  }
  const after = await getGallery(db, workspace, galleryId);
  const duplicate = (await listExternalReferences(db, workspace, galleryId)).find(
    (reference) => reference.normalized_key === input.normalizedKey,
  );
  if (duplicate) return { status: "unchanged", value: duplicate };
  if (!after) return { status: "not_found", entity: "gallery" };
  if (after.version !== input.expectedVersion)
    return { status: "conflict", currentVersion: after.version };
  return (await listExternalReferences(db, workspace, galleryId)).length >= MAX_GALLERY_REFERENCES
    ? { status: "limit", limit: MAX_GALLERY_REFERENCES }
    : { status: "conflict", currentVersion: after.version };
}

export async function removeExternalReference(
  db: D1Database,
  workspace: string,
  galleryId: string,
  referenceId: string,
  expectedVersion: number,
  now = new Date(),
): Promise<MutationResult> {
  const iso = now.toISOString();
  const [updated, removed] = await db.batch([
    db
      .prepare(
        `UPDATE galleries SET version = version + 1, updated_at = ?
       WHERE id = ? AND workspace = ? AND deleted_at IS NULL AND version = ?
         AND EXISTS (SELECT 1 FROM gallery_external_references r WHERE r.id = ? AND r.gallery_id = galleries.id)`,
      )
      .bind(iso, galleryId, workspace, expectedVersion, referenceId),
    db
      .prepare(
        `DELETE FROM gallery_external_references WHERE id = ? AND gallery_id = ? AND EXISTS
       (SELECT 1 FROM galleries g WHERE g.id = gallery_id AND g.workspace = ? AND g.version = ? + 1)`,
      )
      .bind(referenceId, galleryId, workspace, expectedVersion),
  ]);
  if (updated.meta.changes === 1 && removed.meta.changes === 1)
    return { status: "ok", value: undefined };
  return classifyVersion(db, workspace, galleryId, expectedVersion, "reference");
}

export async function findGalleriesByReference(
  db: D1Database,
  workspace: string,
  normalizedKey: string,
  options: { limit?: number; cursor?: GalleryCursor } = {},
): Promise<GalleryPage> {
  const limit = clampGalleryPageLimit(options.limit);
  const cursor = options.cursor;
  const result = await db
    .prepare(
      `SELECT g.id, g.workspace, g.title, g.description, g.visibility, g.cover_item_id, g.version,
            g.created_at, g.updated_at, g.deleted_at
     FROM galleries g JOIN gallery_external_references r ON r.gallery_id = g.id
     WHERE r.normalized_key = ? AND g.workspace = ? AND g.deleted_at IS NULL
       AND (? IS NULL OR g.created_at < ? OR (g.created_at = ? AND g.id < ?))
     ORDER BY g.created_at DESC, g.id DESC LIMIT ?`,
    )
    .bind(
      normalizedKey,
      workspace,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<GalleryRecord>();
  const galleries = result.results.slice(0, limit);
  const last = galleries.at(-1);
  return {
    galleries,
    nextCursor:
      result.results.length > limit && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}
