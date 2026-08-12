/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  MAX_GALLERIES_PER_WORKSPACE,
  MAX_GALLERY_ITEMS,
  MAX_GALLERY_PAGE_SIZE,
  addExternalReference,
  addGalleryItem,
  countItemsForGalleries,
  createGallery,
  deleteGalleriesForWorkspace,
  getGallery,
  listExternalReferences,
  listExternalReferencesForGalleries,
  listGalleryItems,
  removeExternalReference,
  removeGalleryItem,
  reorderGalleryItems,
} from "../src/galleries";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260711180000_galleries.sql";
const PRAGMAS = ["PRAGMA foreign_keys = ON"];

function newSqliteD1(): SqliteD1 {
  return new SqliteD1(MIGRATION, PRAGMAS);
}

async function gallery(sqlite: SqliteD1, workspace = "alpha") {
  const created = await createGallery(database(sqlite), {
    workspace,
    title: "Gallery",
    now: new Date("2026-07-11T12:00:00Z"),
  });
  if (created.status !== "ok") throw new Error(`create failed: ${created.status}`);
  return created.value;
}

describe("gallery persistence against SQLite", () => {
  it("applies the migration with foreign keys and cascades hard deletes", async () => {
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const item = await addGalleryItem(database(sqlite), "alpha", created.id, {
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
      });
      expect(item.status).toBe("ok");
      const reference = await addExternalReference(database(sqlite), "alpha", created.id, {
        expectedVersion: 2,
        provider: "github",
        resourceType: "item",
        normalizedKey: "github:item:buildinternet/uploads#123",
        locator: { owner: "buildinternet", repository: "uploads", number: 123 },
        canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
      });
      expect(reference.status).toBe("ok");

      sqlite.db.prepare("DELETE FROM galleries WHERE id = ?").run(created.id);

      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM gallery_items").get()).toMatchObject({
        count: 0,
      });
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS count FROM gallery_external_references").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps item mutations versioned, tenant-scoped, ordered, and idempotent", async () => {
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const first = await addGalleryItem(database(sqlite), "alpha", created.id, {
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
      });
      expect(first).toMatchObject({ status: "ok", value: { position: 1000 } });
      if (first.status !== "ok") throw new Error("first add failed");

      await expect(
        addGalleryItem(database(sqlite), "alpha", created.id, {
          expectedVersion: 1,
          objectKey: "screenshots/one.png",
        }),
      ).resolves.toMatchObject({ status: "unchanged", value: { id: first.value.id } });

      const second = await addGalleryItem(database(sqlite), "alpha", created.id, {
        expectedVersion: 2,
        objectKey: "screenshots/two.png",
      });
      expect(second).toMatchObject({ status: "ok", value: { position: 2000 } });
      if (second.status !== "ok") throw new Error("second add failed");

      const reordered = await reorderGalleryItems(
        database(sqlite),
        "alpha",
        created.id,
        [second.value.id, first.value.id],
        3,
      );
      expect(reordered).toMatchObject({ status: "ok" });
      await expect(listGalleryItems(database(sqlite), "alpha", created.id)).resolves.toMatchObject([
        { id: second.value.id, position: 1000 },
        { id: first.value.id, position: 2000 },
      ]);

      await expect(
        removeGalleryItem(database(sqlite), "beta", created.id, first.value.id, 4),
      ).resolves.toEqual({ status: "not_found", entity: "gallery" });
      await expect(
        removeGalleryItem(database(sqlite), "alpha", created.id, "missing", 4),
      ).resolves.toEqual({ status: "not_found", entity: "item" });
      await expect(getGallery(database(sqlite), "alpha", created.id)).resolves.toMatchObject({
        version: 4,
      });

      await expect(
        removeGalleryItem(database(sqlite), "alpha", created.id, first.value.id, 4),
      ).resolves.toMatchObject({ status: "ok" });
      await expect(getGallery(database(sqlite), "alpha", created.id)).resolves.toMatchObject({
        version: 5,
      });
    } finally {
      sqlite.close();
    }
  });

  it("enforces the active-gallery cap atomically per workspace", async () => {
    const sqlite = newSqliteD1();
    try {
      for (let index = 0; index < MAX_GALLERIES_PER_WORKSPACE; index++) {
        await expect(gallery(sqlite)).resolves.toMatchObject({ workspace: "alpha" });
      }
      await expect(
        createGallery(database(sqlite), { workspace: "alpha", title: "Overflow gallery" }),
      ).resolves.toEqual({ status: "limit", limit: MAX_GALLERIES_PER_WORKSPACE });
      await expect(
        createGallery(database(sqlite), { workspace: "beta", title: "Beta gallery" }),
      ).resolves.toMatchObject({ status: "ok" });
    } finally {
      sqlite.close();
    }
  });

  it("enforces the item cap inside the conditional insert", async () => {
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const insert = sqlite.db.prepare(
        "INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (let index = 0; index < MAX_GALLERY_ITEMS; index++) {
        insert.run(
          `item-${index}`,
          created.id,
          `screenshots/${index}.png`,
          (index + 1) * 1000,
          created.created_at,
        );
      }

      await expect(
        addGalleryItem(database(sqlite), "alpha", created.id, {
          expectedVersion: 1,
          objectKey: "screenshots/overflow.png",
        }),
      ).resolves.toEqual({ status: "limit", limit: MAX_GALLERY_ITEMS });
      await expect(getGallery(database(sqlite), "alpha", created.id)).resolves.toMatchObject({
        version: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it("reorders a full-size gallery without blowing D1's bound-parameter cap", async () => {
    // The guard statement used to enumerate every item id as its own bound
    // parameter, so a MAX_GALLERY_ITEMS reorder bound 106 and D1 rejected the
    // whole batch with "too many SQL variables" (same defect class as the
    // screenshots by-path 500). SqliteD1.bind() enforces the same 100 cap.
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const insert = sqlite.db.prepare(
        "INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const ids = Array.from({ length: MAX_GALLERY_ITEMS }, (_, index) => `item-${index}`);
      ids.forEach((id, index) => {
        insert.run(
          id,
          created.id,
          `screenshots/${index}.png`,
          (index + 1) * 1000,
          created.created_at,
        );
      });

      const reversed = [...ids].reverse();
      await expect(
        reorderGalleryItems(database(sqlite), "alpha", created.id, reversed, 1),
      ).resolves.toMatchObject({ status: "ok" });
      const items = await listGalleryItems(database(sqlite), "alpha", created.id);
      expect(items.map((item) => item.id)).toEqual(reversed);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a reorder whose ids are not the gallery's current set", async () => {
    // Companion to the test above: the guard's set-equality check must keep
    // working after the id list stopped being one-parameter-per-id.
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const first = await addGalleryItem(database(sqlite), "alpha", created.id, {
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
      });
      if (first.status !== "ok") throw new Error("add failed");

      await expect(
        reorderGalleryItems(database(sqlite), "alpha", created.id, ["not-an-item"], 2),
      ).resolves.toMatchObject({ status: "invalid" });
      await expect(listGalleryItems(database(sqlite), "alpha", created.id)).resolves.toMatchObject([
        { id: first.value.id, position: 1000 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("counts items and external refs for a full page of galleries in one pass", async () => {
    // countItemsForGalleries / listExternalReferencesForGalleries bind the
    // workspace plus one parameter per gallery id, so a full
    // MAX_GALLERY_PAGE_SIZE page bound 101 and 500ed on the account list.
    const sqlite = newSqliteD1();
    try {
      const ids: string[] = [];
      for (let index = 0; index < MAX_GALLERY_PAGE_SIZE; index++) {
        const created = await createGallery(database(sqlite), {
          workspace: "alpha",
          title: `Gallery ${index}`,
          now: new Date("2026-07-11T12:00:00Z"),
        });
        if (created.status !== "ok") throw new Error(`create failed: ${created.status}`);
        ids.push(created.value.id);
        const item = await addGalleryItem(database(sqlite), "alpha", created.value.id, {
          expectedVersion: 1,
          objectKey: `screenshots/${index}.png`,
        });
        if (item.status !== "ok") throw new Error("add failed");
        const reference = await addExternalReference(database(sqlite), "alpha", created.value.id, {
          expectedVersion: 2,
          provider: "github",
          resourceType: "item",
          normalizedKey: `github:item:buildinternet/uploads#${index}`,
          locator: { owner: "buildinternet", repository: "uploads", number: index },
          canonicalUrl: `https://github.com/buildinternet/uploads/issues/${index}`,
        });
        if (reference.status !== "ok") throw new Error("reference failed");
      }

      const counts = await countItemsForGalleries(database(sqlite), "alpha", ids);
      expect(counts.size).toBe(MAX_GALLERY_PAGE_SIZE);
      expect(counts.get(ids[0])).toBe(1);
      expect(counts.get(ids[MAX_GALLERY_PAGE_SIZE - 1])).toBe(1);

      const refs = await listExternalReferencesForGalleries(database(sqlite), "alpha", ids);
      expect(refs.size).toBe(MAX_GALLERY_PAGE_SIZE);
      expect(refs.get(ids[MAX_GALLERY_PAGE_SIZE - 1])).toHaveLength(1);
      // Another workspace must not see them, however the ids were chunked.
      expect((await countItemsForGalleries(database(sqlite), "beta", ids)).size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("keeps external-reference retries idempotent and removals precise", async () => {
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const input = {
        expectedVersion: 1,
        provider: "github",
        resourceType: "item",
        normalizedKey: "github:item:buildinternet/uploads#123",
        locator: { owner: "buildinternet", repository: "uploads", number: 123 },
        canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
      };
      const added = await addExternalReference(database(sqlite), "alpha", created.id, input);
      expect(added.status).toBe("ok");
      if (added.status !== "ok") throw new Error("reference add failed");

      await expect(
        addExternalReference(database(sqlite), "alpha", created.id, input),
      ).resolves.toMatchObject({ status: "unchanged", value: { id: added.value.id } });
      await expect(
        addExternalReference(database(sqlite), "alpha", created.id, {
          ...input,
          expectedVersion: 2,
          normalizedKey: "bad",
          canonicalUrl: "javascript:alert(1)",
        }),
      ).resolves.toMatchObject({ status: "invalid", field: "canonicalUrl" });

      await expect(
        removeExternalReference(database(sqlite), "alpha", created.id, "missing", 2),
      ).resolves.toEqual({ status: "not_found", entity: "reference" });
      await expect(getGallery(database(sqlite), "alpha", created.id)).resolves.toMatchObject({
        version: 2,
      });
      await expect(
        removeExternalReference(database(sqlite), "alpha", created.id, added.value.id, 2),
      ).resolves.toMatchObject({ status: "ok" });
      await expect(listExternalReferences(database(sqlite), "alpha", created.id)).resolves.toEqual(
        [],
      );
    } finally {
      sqlite.close();
    }
  });

  it("allows only one of two concurrent same-version mutations to commit", async () => {
    const sqlite = newSqliteD1();
    try {
      const created = await gallery(sqlite);
      const results = await Promise.all([
        addGalleryItem(database(sqlite), "alpha", created.id, {
          expectedVersion: 1,
          objectKey: "screenshots/a.png",
        }),
        addGalleryItem(database(sqlite), "alpha", created.id, {
          expectedVersion: 1,
          objectKey: "screenshots/b.png",
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "ok"]);
      await expect(listGalleryItems(database(sqlite), "alpha", created.id)).resolves.toHaveLength(
        1,
      );
      await expect(getGallery(database(sqlite), "alpha", created.id)).resolves.toMatchObject({
        version: 2,
      });
    } finally {
      sqlite.close();
    }
  });

  it("deleteGalleriesForWorkspace hard-deletes a workspace's galleries, items, and references, leaving others intact", async () => {
    const sqlite = newSqliteD1();
    try {
      const alpha = await gallery(sqlite, "alpha");
      await addGalleryItem(database(sqlite), "alpha", alpha.id, {
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
      });
      await addExternalReference(database(sqlite), "alpha", alpha.id, {
        expectedVersion: 2,
        provider: "github",
        resourceType: "item",
        normalizedKey: "github:item:buildinternet/uploads#123",
        locator: { owner: "buildinternet", repository: "uploads", number: 123 },
        canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
      });
      const beta = await gallery(sqlite, "beta");
      await addGalleryItem(database(sqlite), "beta", beta.id, {
        expectedVersion: 1,
        objectKey: "screenshots/two.png",
      });

      const result = await deleteGalleriesForWorkspace(database(sqlite), "alpha");
      expect(result).toEqual({ galleries: 1 });

      expect(
        sqlite.db
          .prepare("SELECT COUNT(*) AS count FROM galleries WHERE workspace = 'alpha'")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM gallery_items").get()).toMatchObject({
        count: 1,
      });
      expect(
        sqlite.db.prepare("SELECT COUNT(*) AS count FROM gallery_external_references").get(),
      ).toMatchObject({ count: 0 });
      await expect(getGallery(database(sqlite), "beta", beta.id)).resolves.toMatchObject({
        id: beta.id,
      });
    } finally {
      sqlite.close();
    }
  });
});
