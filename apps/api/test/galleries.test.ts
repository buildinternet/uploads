import { describe, expect, it } from "vitest";
import {
  clampGalleryPageLimit,
  createGallery,
  getGallery,
  listGalleries,
  projectPublicGallery,
  resolvePublicGallery,
  softDeleteGallery,
  updateGallery,
  type GalleryRecord,
} from "../src/galleries";

type Result = { success: true; meta: { changes: number }; results: never[] };

class FakeStatement {
  values: unknown[] = [];
  constructor(
    readonly db: FakeD1,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  first<T>() {
    return Promise.resolve(this.db.first(this) as T | null);
  }
  all<T>() {
    return Promise.resolve({
      success: true,
      results: this.db.all(this) as T[],
      meta: {},
    } as D1Result<T>);
  }
  run() {
    return Promise.resolve(this.db.run(this) as unknown as D1Result);
  }
}

class FakeD1 {
  galleries: GalleryRecord[] = [];
  prepare(sql: string) {
    return new FakeStatement(this, sql.replace(/\s+/g, " ").trim());
  }
  first(statement: FakeStatement): GalleryRecord | null {
    const { sql, values } = statement;
    if (!sql.includes("FROM galleries")) throw new Error(`unsupported first: ${sql}`);
    const [id] = values as string[];
    const row = this.galleries.find((gallery) => gallery.id === id && gallery.deleted_at === null);
    if (!row) return null;
    if (sql.includes("workspace = ?") && row.workspace !== values[1]) return null;
    return structuredClone(row);
  }
  all(statement: FakeStatement): GalleryRecord[] {
    const workspace = statement.values[0] as string;
    const limit = statement.values.at(-1) as number;
    let rows = this.galleries.filter(
      (gallery) => gallery.workspace === workspace && gallery.deleted_at === null,
    );
    if (statement.sql.includes("created_at < ?")) {
      const [, createdAt, , id] = statement.values as string[];
      rows = rows.filter(
        (gallery) =>
          gallery.created_at < createdAt || (gallery.created_at === createdAt && gallery.id < id),
      );
    }
    return structuredClone(
      rows
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, limit),
    );
  }
  run(statement: FakeStatement): Result {
    const { sql, values } = statement;
    if (sql.startsWith("INSERT INTO galleries")) {
      const [id, workspace, title, description, createdAt, updatedAt] = values as string[];
      this.galleries.push({
        id,
        workspace,
        title,
        description: description ?? null,
        visibility: "public",
        cover_item_id: null,
        version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
        deleted_at: null,
      });
      return result(1);
    }
    if (sql.startsWith("UPDATE galleries SET deleted_at")) {
      const [deletedAt, updatedAt, id, workspace, version] = values as [
        string,
        string,
        string,
        string,
        number,
      ];
      const row = this.galleries.find(
        (gallery) =>
          gallery.id === id &&
          gallery.workspace === workspace &&
          gallery.deleted_at === null &&
          gallery.version === version,
      );
      if (!row) return result(0);
      row.deleted_at = deletedAt;
      row.updated_at = updatedAt;
      row.version += 1;
      return result(1);
    }
    if (sql.startsWith("UPDATE galleries SET title")) {
      const [title, description, cover, updatedAt, id, workspace, version] = values as [
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        number,
      ];
      const row = this.galleries.find(
        (gallery) =>
          gallery.id === id &&
          gallery.workspace === workspace &&
          gallery.deleted_at === null &&
          gallery.version === version,
      );
      if (!row || cover !== null) return result(0);
      row.title = title;
      row.description = description;
      row.cover_item_id = cover;
      row.updated_at = updatedAt;
      row.version += 1;
      return result(1);
    }
    throw new Error(`unsupported run: ${sql}`);
  }
}

function result(changes: number): Result {
  return { success: true, meta: { changes }, results: [] };
}

function database(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}

async function create(fake: FakeD1, workspace = "alpha", title = "Gallery") {
  const created = await createGallery(database(fake), {
    workspace,
    title,
    now: new Date("2026-07-11T12:00:00Z"),
  });
  if (created.status !== "ok") throw new Error(`create failed: ${created.status}`);
  return created.value;
}

describe("gallery persistence", () => {
  it("clamps finite page limits and defaults non-finite values", () => {
    expect(clampGalleryPageLimit(undefined)).toBe(50);
    expect(clampGalleryPageLimit(Number.NaN)).toBe(50);
    expect(clampGalleryPageLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampGalleryPageLimit(0)).toBe(1);
    expect(clampGalleryPageLimit(1000)).toBe(100);
  });

  it("creates opaque 128-bit IDs and isolates owner reads by workspace", async () => {
    const fake = new FakeD1();
    const gallery = await create(fake);
    expect(gallery.id).toMatch(/^gal_[A-Za-z0-9_-]{22}$/);
    await expect(getGallery(database(fake), "alpha", gallery.id)).resolves.toMatchObject({
      id: gallery.id,
    });
    await expect(getGallery(database(fake), "beta", gallery.id)).resolves.toBeNull();
  });

  it("validates the plain-text contract before writing", async () => {
    const fake = new FakeD1();
    await expect(
      createGallery(database(fake), { workspace: "alpha", title: "   " }),
    ).resolves.toMatchObject({ status: "invalid", field: "title" });
    await expect(
      createGallery(database(fake), {
        workspace: "alpha",
        title: "ok",
        description: "bad\u0000text",
      }),
    ).resolves.toMatchObject({ status: "invalid", field: "description" });
    expect(fake.galleries).toHaveLength(0);
  });

  it("uses CAS for updates and distinguishes unchanged and conflicts", async () => {
    const fake = new FakeD1();
    const gallery = await create(fake);
    await expect(
      updateGallery(database(fake), "alpha", gallery.id, { expectedVersion: 1 }),
    ).resolves.toMatchObject({ status: "unchanged" });
    await expect(
      updateGallery(database(fake), "alpha", gallery.id, { expectedVersion: 1, title: "Updated" }),
    ).resolves.toMatchObject({ status: "ok", value: { version: 2 } });
    await expect(
      updateGallery(database(fake), "alpha", gallery.id, { expectedVersion: 1, title: "Stale" }),
    ).resolves.toEqual({ status: "conflict", currentVersion: 2 });
  });

  it("soft-deletes only the matching tenant and expected version", async () => {
    const fake = new FakeD1();
    const gallery = await create(fake);
    await expect(softDeleteGallery(database(fake), "beta", gallery.id, 1)).resolves.toEqual({
      status: "not_found",
      entity: "gallery",
    });
    await expect(softDeleteGallery(database(fake), "alpha", gallery.id, 2)).resolves.toEqual({
      status: "conflict",
      currentVersion: 1,
    });
    await expect(softDeleteGallery(database(fake), "alpha", gallery.id, 1)).resolves.toMatchObject({
      status: "ok",
    });
    await expect(getGallery(database(fake), "alpha", gallery.id)).resolves.toBeNull();
  });

  it("bounds compound-cursor listing and never crosses workspaces", async () => {
    const fake = new FakeD1();
    const one = await create(fake, "alpha", "One");
    await create(fake, "beta", "Other");
    const two = await create(fake, "alpha", "Two");
    two.created_at = "2026-07-12T12:00:00.000Z";
    fake.galleries.find((row) => row.id === two.id)!.created_at = two.created_at;
    const first = await listGalleries(database(fake), "alpha", { limit: 1 });
    expect(first.galleries.map((row) => row.id)).toEqual([two.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listGalleries(database(fake), "alpha", {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.galleries.map((row) => row.id)).toEqual([one.id]);
  });

  it("keeps workspace ownership internal to public projection", async () => {
    const fake = new FakeD1();
    const gallery = await create(fake);
    const internal = await resolvePublicGallery(database(fake), gallery.id);
    expect(internal?.workspace).toBe("alpha");
    expect(projectPublicGallery(internal!)).not.toHaveProperty("workspace");
  });
});
