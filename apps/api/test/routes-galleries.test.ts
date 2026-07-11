import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";

const TOKEN = "gallery-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class SQLiteStatement {
  values: unknown[] = [];
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  first<T>() {
    return Promise.resolve(
      (this.database.prepare(this.sql).get(...(this.values as SQLInputValue[])) as T | undefined) ??
        null,
    );
  }
  all<T>() {
    return Promise.resolve({
      success: true,
      results: this.database.prepare(this.sql).all(...(this.values as SQLInputValue[])) as T[],
      meta: {},
    } as D1Result<T>);
  }
  run() {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]));
    return Promise.resolve({
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result);
  }
}

class SQLiteD1 {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string) {
    return new SQLiteStatement(this.database, sql);
  }
  async batch(statements: SQLiteStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

let db: DatabaseSync;
let bucket: FakeR2Bucket;
let env: Parameters<typeof app.request>[2];

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../migrations/20260710120000_auth.sql", import.meta.url)),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../migrations/20260711180000_galleries.sql", import.meta.url)),
      "utf8",
    ),
  );
  bucket = new FakeR2Bucket();
  await bucket.put("alpha/screenshots/one.png", PNG);
  const records: Record<string, WorkspaceRecord> = {
    alpha: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "alpha/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
    beta: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "beta/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
  };
  env = {
    DB: new SQLiteD1(db) as unknown as D1Database,
    REGISTRY: { get: async (key: string) => records[key.slice(3)] ?? null },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  } as Parameters<typeof app.request>[2];
});

function request(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    env,
  );
}

async function create() {
  const response = await request("/v1/alpha/galleries", {
    method: "POST",
    body: JSON.stringify({ title: "Launch media" }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    id: string;
    version: number;
    items: { id: string; objectKey: string; status: string }[];
  }>;
}

describe("gallery routes with SQLite D1", () => {
  it("creates, reads, updates and isolates gallery ownership", async () => {
    const gallery = await create();
    expect(gallery.id).toMatch(/^gal_/);
    expect((await request(`/v1/alpha/galleries/${gallery.id}`)).status).toBe(200);
    expect((await request(`/v1/beta/galleries/${gallery.id}`)).status).toBe(404);
    const updated = await request(`/v1/alpha/galleries/${gallery.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, title: "Updated" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as object).toMatchObject({ title: "Updated", version: 2 });
    const stale = await request(`/v1/alpha/galleries/${gallery.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, title: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: {
        code: "gallery_version_conflict",
        type: "conflict",
        message: "Gallery was changed by another request.",
        details: { currentVersion: 2 },
      },
    });
  });

  it("adds only existing public objects and keeps deleted objects as tombstones", async () => {
    const gallery = await create();
    const missing = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, objectKey: "screenshots/missing.png" }),
    });
    expect(missing.status).toBe(404);
    const added = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
        altText: "One",
      }),
    });
    expect(added.status).toBe(201);
    const item = (await added.json()) as { id: string };
    const duplicate = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2, objectKey: "screenshots/one.png" }),
    });
    expect(duplicate.status).toBe(200);
    await bucket.delete("alpha/screenshots/one.png");
    const staleTombstoneRetry = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
        altText: "One",
      }),
    });
    expect(staleTombstoneRetry.status).toBe(200);
    expect(await staleTombstoneRetry.json()).toMatchObject({
      id: item.id,
      status: "missing",
      url: null,
    });
    const owner = await request(`/v1/alpha/galleries/${gallery.id}`);
    expect((await owner.json()) as object).toMatchObject({
      version: 2,
      items: [{ id: item.id, status: "missing", url: null }],
    });
    await bucket.put("alpha/screenshots/one.png", PNG);
    expect(
      (await (await request(`/v1/alpha/galleries/${gallery.id}`)).json()) as object,
    ).toMatchObject({
      items: [{ id: item.id, status: "available" }],
    });
  });

  it("replaces the complete order, removes membership, and permits re-add", async () => {
    await bucket.put("alpha/screenshots/two.png", PNG);
    const gallery = await create();
    const first = (await (
      await request(`/v1/alpha/galleries/${gallery.id}/items`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: 1, objectKey: "screenshots/one.png" }),
      })
    ).json()) as { id: string };
    const second = (await (
      await request(`/v1/alpha/galleries/${gallery.id}/items`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: 2, objectKey: "screenshots/two.png" }),
      })
    ).json()) as { id: string };
    const reordered = await request(`/v1/alpha/galleries/${gallery.id}/items/order`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 3, itemIds: [second.id, first.id] }),
    });
    expect(reordered.status).toBe(200);
    expect(
      ((await reordered.json()) as { items: { id: string }[] }).items.map((item) => item.id),
    ).toEqual([second.id, first.id]);
    expect(
      (
        await request(`/v1/alpha/galleries/${gallery.id}/items/${first.id}`, {
          method: "DELETE",
          body: JSON.stringify({ expectedVersion: 4 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/alpha/galleries/${gallery.id}/items`, {
          method: "POST",
          body: JSON.stringify({ expectedVersion: 5, objectKey: "screenshots/one.png" }),
        })
      ).status,
    ).toBe(201);
  });

  it("returns an allowlisted public projection and supports JSON deletes", async () => {
    const gallery = await create();
    const added = await request(`/v1/alpha/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        objectKey: "screenshots/one.png",
        caption: "Launch",
        altText: "Screenshot",
      }),
    });
    expect(added.status).toBe(201);
    const publicResponse = await app.request(`/public/galleries/${gallery.id}`, {}, env);
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as Record<string, unknown>;
    expect(publicBody).not.toHaveProperty("workspace");
    expect(publicBody).not.toHaveProperty("deletedAt");
    const publicItem = (publicBody.items as Record<string, unknown>[])[0];
    expect(Object.keys(publicItem)).toEqual([
      "id",
      "filename",
      "position",
      "caption",
      "altText",
      "status",
      "url",
      "contentType",
    ]);
    expect(publicItem).toMatchObject({
      filename: "one.png",
      contentType: "application/octet-stream",
      status: "available",
      caption: "Launch",
      altText: "Screenshot",
    });
    const removed = await request(`/v1/alpha/galleries/${gallery.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true, id: gallery.id });
    expect((await app.request(`/public/galleries/${gallery.id}`, {}, env)).status).toBe(404);
  });

  it("lists summaries without probing object storage", async () => {
    await create();
    let probes = 0;
    const originalHead = bucket.head.bind(bucket);
    bucket.head = async (key: string) => {
      probes++;
      return originalHead(key);
    };
    const response = await request("/v1/alpha/galleries");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { galleries: Record<string, unknown>[] };
    expect(body.galleries[0]).not.toHaveProperty("items");
    expect(probes).toBe(0);
  });

  it("rejects cross-tenant item mutation before probing storage", async () => {
    const gallery = await create();
    let probes = 0;
    const originalExists = bucket.head.bind(bucket);
    bucket.head = async (key: string) => {
      probes++;
      return originalExists(key);
    };
    const response = await request(`/v1/beta/galleries/${gallery.id}/items`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, objectKey: "screenshots/one.png" }),
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "gallery_not_found",
    );
    expect(probes).toBe(0);
  });

  it("supports GitHub alias lifecycle and paginated many-to-many lookup", async () => {
    const gallery = await create();
    const linked = await request(`/v1/alpha/galleries/${gallery.id}/external-references`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        provider: "github",
        coordinate: "BuildInternet/Uploads#123",
      }),
    });
    expect(linked.status).toBe(201);
    const reference = (await linked.json()) as {
      id: string;
      coordinate: string;
      canonicalUrl: string;
    };
    expect(reference).toMatchObject({
      coordinate: "buildinternet/uploads#123",
      canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
    });
    const newAlias = await request(`/v1/alpha/galleries/${gallery.id}/external-references`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 2,
        provider: "github",
        coordinate: "buildinternet/new-uploads#123",
      }),
    });
    expect(newAlias.status).toBe(201);
    const secondGallery = await create();
    expect(
      (
        await request(`/v1/alpha/galleries/${secondGallery.id}/external-references`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: 1,
            provider: "github",
            coordinate: "buildinternet/uploads#123",
          }),
        })
      ).status,
    ).toBe(201);
    const reverse = await request(
      "/v1/alpha/galleries/by-reference?provider=github&coordinate=BUILDINTERNET%2FUPLOADS%23123&limit=1",
    );
    expect(reverse.status).toBe(200);
    const firstPage = (await reverse.json()) as {
      galleries: { id: string }[];
      nextCursor: string;
    };
    expect(firstPage.galleries).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const next = await request(
      `/v1/alpha/galleries/by-reference?provider=github&coordinate=buildinternet%2Fuploads%23123&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    const secondPage = (await next.json()) as { galleries: { id: string }[] };
    expect(
      new Set([...firstPage.galleries, ...secondPage.galleries].map((entry) => entry.id)),
    ).toEqual(new Set([gallery.id, secondGallery.id]));
    const other = await request(
      "/v1/beta/galleries/by-reference?provider=github&coordinate=buildinternet%2Fuploads%23123",
    );
    expect(((await other.json()) as { galleries: unknown[] }).galleries).toEqual([]);
    const foreignRemove = await request(
      `/v1/beta/galleries/${gallery.id}/external-references/${reference.id}`,
      { method: "DELETE", body: JSON.stringify({ expectedVersion: 3 }) },
    );
    expect(await foreignRemove.json()).toMatchObject({
      error: { code: "gallery_not_found", type: "not_found" },
    });
    const removed = await request(
      `/v1/alpha/galleries/${gallery.id}/external-references/${reference.id}`,
      { method: "DELETE", body: JSON.stringify({ expectedVersion: 3 }) },
    );
    expect(removed.status).toBe(200);
    const newReverse = await request(
      "/v1/alpha/galleries/by-reference?provider=github&coordinate=buildinternet%2Fnew-uploads%23123",
    );
    expect(((await newReverse.json()) as { galleries: { id: string }[] }).galleries).toEqual([
      expect.objectContaining({ id: gallery.id }),
    ]);
    const oldReverse = await request(
      "/v1/alpha/galleries/by-reference?provider=github&coordinate=buildinternet%2Fuploads%23123",
    );
    expect(((await oldReverse.json()) as { galleries: { id: string }[] }).galleries).toEqual([
      expect.objectContaining({ id: secondGallery.id }),
    ]);
    const missing = await request(
      `/v1/alpha/galleries/${gallery.id}/external-references/${reference.id}`,
      { method: "DELETE", body: JSON.stringify({ expectedVersion: 4 }) },
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "gallery_reference_not_found",
    );
  });

  it("resolves the parent before validating a reference input", async () => {
    const gallery = await create();
    const foreign = await request(`/v1/beta/galleries/${gallery.id}/external-references`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, provider: "bad", coordinate: "bad" }),
    });
    expect(await foreign.json()).toMatchObject({
      error: { code: "gallery_not_found", type: "not_found" },
    });
    const owned = await request(`/v1/alpha/galleries/${gallery.id}/external-references`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, provider: "bad", coordinate: "bad" }),
    });
    expect(await owned.json()).toEqual({
      error: {
        code: "gallery_invalid_reference",
        type: "validation",
        message: "provider must be github",
      },
    });
  });

  it("distinguishes a missing gallery from a missing item without changing version", async () => {
    const gallery = await create();
    const foreign = await request(`/v1/beta/galleries/${gallery.id}/items/missing`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({
      error: { code: "gallery_not_found", type: "not_found" },
    });

    const missingItem = await request(`/v1/alpha/galleries/${gallery.id}/items/missing`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(missingItem.status).toBe(404);
    expect(await missingItem.json()).toMatchObject({
      error: { code: "gallery_item_not_found", type: "not_found" },
    });
    expect(await (await request(`/v1/alpha/galleries/${gallery.id}`)).json()).toMatchObject({
      version: 1,
    });
  });

  it("requires expectedVersion and runs the write limiter", async () => {
    const gallery = await create();
    expect(
      (
        await request(`/v1/alpha/galleries/${gallery.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "No CAS" }),
        })
      ).status,
    ).toBe(400);
    env = { ...env, WRITE_LIMITER: { limit: async () => ({ success: false }) } } as Parameters<
      typeof app.request
    >[2];
    expect(
      (
        await request("/v1/alpha/galleries", {
          method: "POST",
          body: JSON.stringify({ title: "Blocked" }),
        })
      ).status,
    ).toBe(429);
  });
});
