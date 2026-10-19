/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/viewer";
import { replaceFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { FakeR2Bucket } from "./fake-r2";
import { FakeKv, fakeRegistry } from "./fake-kv";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";

import { SqliteD1, database } from "./helpers/sqlite-d1";
import { sha256Hex } from "../src/workspace";

const KEY = "screenshots/shot.png";
const PATH = `/public/files/default/${KEY}`;
const BYTES = new Uint8Array([1, 2, 3]);
function fixture() {
  const table = new FileMetadataTable();
  const session = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first() {
          return null;
        },
        async all<T>() {
          return table.tryAll<T>(normalized, args) ?? { success: true, results: [] };
        },
        async run() {
          return table.tryRun(normalized, args) ?? { success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const withSession = vi.fn(() => session);
  const bucket = new FakeR2Bucket();
  const env = {
    DB: { ...session, withSession },
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: fakeRegistry({
      default: {
        provider: "r2",
        bucket: "uploads-default",
        binding: "UPLOADS_DEFAULT",
        prefix: "default/",
        publicBaseUrl: "https://storage.uploads.sh",
        tokenHash: "unused",
      },
    }),
    UPLOADS_DEFAULT: bucket,
  };
  const seed = (privateObject = false, bytes = BYTES) =>
    bucket.put(`default/${KEY}`, bytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: privateObject ? { visibility: "private" } : {},
    });
  return { env, bucket, session, withSession, seed };
}

describe("viewer worker entrypoint", () => {
  it("serves health without exposing authenticated or mutation routes", async () => {
    const { env } = fixture();
    expect(await (await app.request("/health", {}, env)).json()).toEqual({ ok: true });
    for (const path of ["/me", "/admin/workspaces", "/v1/default/files", "/v1/workspaces"]) {
      expect((await app.request(path, {}, env)).status).toBe(404);
      expect((await app.request(path, { method: "POST" }, env)).status).toBe(404);
    }
    expect((await app.request(PATH, { method: "PUT", body: BYTES }, env)).status).toBe(404);
  });
  it("mounts feed and gallery routers with typed not-found envelopes", async () => {
    const { env } = fixture();
    for (const [path, code] of [
      ["/public/feeds/missing", "feed_not_found"],
      ["/public/galleries/missing", "gallery_not_found"],
    ]) {
      const response = await app.request(path!, {}, env);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });
  it("opens a D1 session per request and uses it for metadata reads", async () => {
    const { env, seed, session, withSession } = fixture();
    await seed();
    const query = vi.spyOn(session, "prepare");
    env.DB.prepare = vi.fn(() => {
      throw new Error("request bypassed its D1 session");
    });
    for (let index = 0; index < 2; index++)
      expect((await app.request(PATH, {}, env)).status).toBe(200);
    expect(withSession).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalled();
  });
  it("rechecks replacements, privacy, holds, and deletions on every open", async () => {
    const { env, bucket, seed, session } = fixture();
    const read = () => app.request(PATH, {}, env);
    await seed();
    expect(await (await read()).json()).toMatchObject({ size: 3 });
    await seed(false, new Uint8Array(7));
    expect(await (await read()).json()).toMatchObject({ size: 7 });
    await seed(true);
    let response = await read();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "auth_required" } });
    await seed();
    await setServerFileMetadata(session as unknown as D1Database, "default", KEY, {
      "ai.hold": "pending",
    });
    expect((await read()).status).toBe(401);
    await setServerFileMetadata(session as unknown as D1Database, "default", KEY, {
      "ai.hold": "approved",
    });
    response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await bucket.delete(`default/${KEY}`);
    expect((await read()).status).toBe(404);
  });
  it("streams guarded downloads with attachment security headers", async () => {
    const { env, seed, session } = fixture();
    await seed();
    const response = await app.request(`${PATH}?download=1`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    await setServerFileMetadata(session as unknown as D1Database, "default", KEY, {
      "ai.hold": "pending",
    });
    const blocked = await app.request(`${PATH}?download=true`, {}, env);
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toMatchObject({ error: { code: "auth_required" } });
  });
});

it("rechecks holds and revocation after a feed item index is cached", async () => {
  const sqlite = new SqliteD1([
    "migrations/20260713210559_file_metadata.sql",
    "migrations/20260915120000_feeds.sql",
    "migrations/20260915153000_feeds_number.sql",
    "migrations/20261004120000_feeds_source.sql",
  ]);
  try {
    const fixtureData = fixture();
    const cache = new FakeKv();
    const env = { ...fixtureData.env, DB: database(sqlite), LIVE_LINK_INDEX: cache };
    await fixtureData.seed();
    await replaceFileMetadata(database(sqlite), "default", KEY, { "gh.repo": "acme/app" });
    const id = "feed_" + "a".repeat(22);
    sqlite.db
      .prepare(
        "INSERT INTO feeds (id, workspace, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, "default", "acme/app", "2026-10-01", "2026-10-01");
    const path = `/public/feeds/${id}/items/${(await sha256Hex(KEY)).slice(0, 32)}`;
    expect((await app.request(path, {}, env)).status).toBe(200);
    expect(cache.store.size).toBe(1);
    await setServerFileMetadata(database(sqlite), "default", KEY, { "ai.hold": "pending" });
    const prepare = vi.spyOn(sqlite, "prepare");
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ item: { status: "withheld", url: null, embedUrl: null } });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("ORDER BY r.updated_at DESC"))).toBe(
      false,
    );
    sqlite.db.prepare("UPDATE feeds SET deleted_at = ? WHERE id = ?").run("2026-10-02", id);
    const revoked = await app.request(path, {}, env);
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toMatchObject({ error: { code: "feed_not_found" } });
  } finally {
    sqlite.close();
  }
});

it("serves gallery DTOs and rechecks private and held download gates", async () => {
  const sqlite = new SqliteD1([
    "migrations/20260711180000_galleries.sql",
    "migrations/20260713210559_file_metadata.sql",
  ]);
  try {
    const source = fixture();
    const env = { ...source.env, DB: database(sqlite) };
    await source.seed();
    sqlite.db
      .prepare(
        "INSERT INTO galleries (id, workspace, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("gallery", "default", "Screenshots", "2026-10-01", "2026-10-01");
    sqlite.db
      .prepare(
        "INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("item", "gallery", KEY, 1, "2026-10-01");
    const path = "/public/galleries/gallery";
    const download = `${path}/items/item/download`;
    const initial = await app.request(path, {}, env);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      title: "Screenshots",
      items: [{ status: "available", filename: "shot.png" }],
    });
    expect((await app.request(download, {}, env)).status).toBe(200);
    await source.seed(true);
    expect((await app.request(download, {}, env)).status).toBe(404);
    expect(await (await app.request(path, {}, env)).json()).toMatchObject({
      items: [{ status: "withheld", url: null }],
    });
    await source.seed();
    await setServerFileMetadata(database(sqlite), "default", KEY, { "ai.hold": "pending" });
    expect((await app.request(download, {}, env)).status).toBe(404);
    const held = await (await app.request(path, {}, env)).json();
    expect(held).toMatchObject({
      items: [{ status: "withheld", filename: "held for review", url: null }],
    });
    expect(JSON.stringify(held)).not.toContain(KEY);
  } finally {
    sqlite.close();
  }
});

it("serves public feed pages with the same pagination DTOs as the API", async () => {
  const { app: api } = await import("../src/index");
  const sqlite = new SqliteD1([
    "migrations/20260713210559_file_metadata.sql",
    "migrations/20260915120000_feeds.sql",
    "migrations/20260915153000_feeds_number.sql",
    "migrations/20261004120000_feeds_source.sql",
  ]);
  try {
    const source = fixture();
    const env = { ...source.env, DB: database(sqlite) };
    const id = "feed_" + "b".repeat(22);
    sqlite.db
      .prepare(
        "INSERT INTO feeds (id, workspace, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, "default", "acme/app", "2026-10-01", "2026-10-01");
    for (let i = 0; i < 51; i++) {
      const key = `screenshots/shot-${String(i).padStart(2, "0")}.png`;
      await source.bucket.put(`default/${key}`, BYTES, {
        httpMetadata: { contentType: "image/png" },
      });
      await replaceFileMetadata(database(sqlite), "default", key, { "gh.repo": "acme/app" });
      sqlite.db
        .prepare("UPDATE file_metadata SET updated_at = ? WHERE object_key = ?")
        .run(new Date(Date.UTC(2026, 9, 1) - i * 60000).toISOString(), key);
    }
    const path = `/public/feeds/${id}`;
    const first = await app.request(path, {}, env);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { filename: string }[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page).toEqual(await (await api.request(path, {}, env)).json());
    const nextPath = `${path}?cursor=${page.nextCursor}`;
    const next = await app.request(nextPath, {}, env);
    expect(next.status).toBe(200);
    const last = await next.json();
    expect(last).toMatchObject({ items: [{ filename: "shot-50.png" }], nextCursor: null });
    expect(last).toEqual(await (await api.request(nextPath, {}, env)).json());
  } finally {
    sqlite.close();
  }
});
