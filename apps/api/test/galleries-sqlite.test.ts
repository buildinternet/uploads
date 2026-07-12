/// <reference types="node" />

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MAX_GALLERIES_PER_WORKSPACE,
  MAX_GALLERY_ITEMS,
  addExternalReference,
  addGalleryItem,
  createGallery,
  getGallery,
  listExternalReferences,
  listGalleryItems,
  removeExternalReference,
  removeGalleryItem,
  reorderGalleryItems,
} from "../src/galleries";

type SqliteValue = string | number | bigint | null | Uint8Array;

class SqliteStatement {
  private values: SqliteValue[] = [];

  constructor(
    readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values as SqliteValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.owner.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.owner.db.prepare(this.sql).all(...this.values) as T[],
      meta: {},
    } as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync() {
    const result = this.owner.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(readFileSync("migrations/20260711180000_galleries.sql", "utf8"));
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync() as unknown as D1Result);
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

function database(sqlite: SqliteD1): D1Database {
  return sqlite as unknown as D1Database;
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
    const sqlite = new SqliteD1();
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
    const sqlite = new SqliteD1();
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
    const sqlite = new SqliteD1();
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
    const sqlite = new SqliteD1();
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

  it("keeps external-reference retries idempotent and removals precise", async () => {
    const sqlite = new SqliteD1();
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
    const sqlite = new SqliteD1();
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
});
