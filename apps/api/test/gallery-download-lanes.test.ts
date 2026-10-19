/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { setServerFileMetadata } from "../src/file-metadata";
import { FakeR2Bucket } from "./fake-r2";
import { fakeRegistry } from "./fake-kv";
import { database, SqliteD1 } from "./helpers/sqlite-d1";
import type { WorkspaceRecord } from "../src/workspace";

const KEY = "shots/old.png";
const PATH = "/public/galleries/gallery/items/item/download";
const BYTES = new Uint8Array([4, 5, 6]);

function fixture(publicFallback = true) {
  const sqlite = new SqliteD1([
    "migrations/20260711180000_galleries.sql",
    "migrations/20260713210559_file_metadata.sql",
  ]);
  sqlite.db
    .prepare(
      "INSERT INTO galleries (id, workspace, title, created_at, updated_at) VALUES ('gallery', 'alpha', 'Shots', '2026-10-01', '2026-10-01')",
    )
    .run();
  sqlite.db
    .prepare(
      "INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at) VALUES ('item', 'gallery', ?, 1, '2026-10-01')",
    )
    .run(KEY);
  const active = new FakeR2Bucket();
  const fallback = new FakeR2Bucket();
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "active",
    binding: "UPLOADS_DEFAULT",
    publicBaseUrl: "https://storage.uploads.sh",
    storageLaneId: "active-lane",
    storageLanes: [
      {
        id: "old-lane",
        provider: "r2",
        bucket: "old",
        binding: "UPLOADS_FALLBACK",
        lastActiveAt: "2026-09-01",
        ...(publicFallback ? { publicBaseUrl: "https://old.example.com" } : {}),
      },
    ],
  };
  const env = {
    DB: database(sqlite),
    REGISTRY: fakeRegistry({ alpha: record }),
    UPLOADS_DEFAULT: active,
    UPLOADS_FALLBACK: fallback,
    WEB_ORIGIN: "https://uploads.test",
  };
  return { sqlite, active, fallback, env };
}

describe("gallery downloads across storage lanes", () => {
  it("streams the fallback lane that the public gallery displays", async () => {
    const { sqlite, fallback, env } = fixture();
    try {
      await fallback.put(KEY, BYTES, { httpMetadata: { contentType: "image/png" } });
      const gallery = await app.request("/public/galleries/gallery", {}, env);
      expect(gallery.status).toBe(200);
      expect(await gallery.json()).toMatchObject({
        items: [{ url: `https://old.example.com/${KEY}` }],
      });
      const response = await app.request(PATH, {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain("attachment");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    } finally {
      sqlite.close();
    }
  });
  it("does not bypass a private active object using a public fallback copy", async () => {
    const { sqlite, active, fallback, env } = fixture();
    try {
      await fallback.put(KEY, BYTES);
      await active.put(KEY, BYTES, { customMetadata: { visibility: "private" } });
      const fallbackGet = vi.spyOn(fallback, "get");
      const response = await app.request(PATH, {}, env);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "gallery_item_not_found" } });
      expect(fallbackGet).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
  it("rechecks holds before streaming an otherwise public fallback", async () => {
    const { sqlite, fallback, env } = fixture();
    try {
      await fallback.put(KEY, BYTES);
      expect((await app.request(PATH, {}, env)).status).toBe(200);
      await setServerFileMetadata(database(sqlite), "alpha", KEY, { "ai.hold": "pending" });
      const get = vi.spyOn(fallback, "get");
      expect((await app.request(PATH, {}, env)).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
  it("denies a fallback without its own public URL even when the active lane is public", async () => {
    const { sqlite, fallback, env } = fixture(false);
    try {
      await fallback.put(KEY, BYTES);
      const get = vi.spyOn(fallback, "get");
      expect((await app.request(PATH, {}, env)).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
