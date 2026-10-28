import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { recordContentHash } from "../src/content-hash";
import { deleteObject } from "../src/files-core";
import { reholdIfHeld } from "../src/held-storage";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { isKeyHeld, listHeldKeys } from "../src/upload-hold-read";
import { hostedGateObjectKeys } from "../src/read-gate";
import { applyUploadHold, approveUpload, holdAgain } from "../src/upload-hold-service";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const API_ROOT = fileURLToPath(new NodeURL("../", import.meta.url));
const SHA = "ab".repeat(32);
const NEXT = "cd".repeat(32);
const ws: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20261028120000_file_events.sql",
  "migrations/20261028140000_blob_hold.sql",
  "migrations/20261028160000_read_gate.sql",
];

function envFor(sqlite: SqliteD1, bucket: FakeR2Bucket) {
  return { DB: database(sqlite), UPLOADS_DEFAULT: bucket } as unknown as Env;
}

describe("blob hold", () => {
  it("keeps a release when the bytes move to a new key", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/old.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = envFor(sqlite, bucket);
    await recordContentHash(db, "acme", "old.png", SHA);
    await setServerFileMetadata(db, "acme", "old.png", {
      "ai.hold": "pending",
      "ai.secret": "token",
    });
    expect(await approveUpload(env, ws, "acme", "old.png", "Member")).toEqual({ approved: true });

    await recordContentHash(db, "acme", "rotated.png", SHA);
    await setServerFileMetadata(db, "acme", "rotated.png", { "ai.hold": "pending" });
    expect(await isKeyHeld(env, "acme", "rotated.png")).toBe(false);
    sqlite.close();
  });

  it("holds the key again when new bytes replace a release", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/shot.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = envFor(sqlite, bucket);
    await recordContentHash(db, "acme", "shot.png", SHA);
    await setServerFileMetadata(db, "acme", "shot.png", { "ai.hold": "pending" });
    await approveUpload(env, ws, "acme", "shot.png", "Member");

    await recordContentHash(db, "acme", "shot.png", NEXT);
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
      )
      .run("acme", NEXT, "2026-10-28T00:00:00.000Z");
    expect(await isKeyHeld(env, "acme", "shot.png")).toBe(true);
    sqlite.close();
  });

  it("backfills a hashed approval and skips a row with no hash", async () => {
    const sqlite = new SqliteD1(MIGRATIONS.slice(0, 3));
    const db = database(sqlite);
    await setServerFileMetadata(db, "acme", "known.png", {
      "ai.hold": "approved",
      "ai.hold.by": "Member",
      "ai.hold.at": "2026-10-01T00:00:00.000Z",
    });
    await recordContentHash(db, "acme", "known.png", SHA);
    await setServerFileMetadata(db, "acme", "unknown.png", { "ai.hold": "approved" });
    sqlite.db.exec(readFileSync(resolve(API_ROOT, MIGRATIONS[3]!), "utf8"));

    expect((await getFileMetadata(db, "acme", "known.png"))["ai.hold"]).toBe("pending");
    expect((await getFileMetadata(db, "acme", "unknown.png"))["ai.hold"]).toBe("approved");
    const blob = await db
      .prepare(`SELECT state, actor FROM blob_hold WHERE workspace = ? AND content_sha256 = ?`)
      .bind("acme", SHA)
      .first<{ state: string; actor: string }>();
    expect(blob).toEqual({ state: "released", actor: "Member" });
    const skipped = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM file_metadata WHERE meta_key = 'ai.hold' AND meta_value = 'approved'`,
      )
      .first<{ n: number }>();
    expect(skipped?.n).toBe(1);
    sqlite.close();
  });

  it("moves every held key of the same bytes on re-hold", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    const held = new FakeR2Bucket();
    const bytes = new Uint8Array([1, 2, 3]);
    await bucket.put("acme/a.png", bytes, { customMetadata: { "content-sha256": SHA } });
    await bucket.put("acme/b.png", bytes, { customMetadata: { "content-sha256": SHA } });
    const env = {
      DB: db,
      UPLOADS_DEFAULT: bucket,
      UPLOADS_HELD: held,
    } as unknown as Env;
    await recordContentHash(db, "acme", "a.png", SHA);
    await recordContentHash(db, "acme", "b.png", SHA);
    await setServerFileMetadata(db, "acme", "a.png", { "ai.hold": "pending" });
    await setServerFileMetadata(db, "acme", "b.png", { "ai.hold": "pending" });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'released', ?, ?)`,
      )
      .run("acme", SHA, "Member", "2026-10-28T00:00:00.000Z");

    expect(await holdAgain(env, ws, "acme", "a.png", "Member")).toEqual({ held: true });
    expect((await getFileMetadata(db, "acme", "a.png"))["ai.hold.moved"]).toBe("1");
    expect((await getFileMetadata(db, "acme", "b.png"))["ai.hold.moved"]).toBe("1");
    expect(await held.head("acme/a.png")).not.toBeNull();
    expect(await held.head("acme/b.png")).not.toBeNull();
    sqlite.close();
  });

  it("fans a hold out to every same-sha key with its own hold row", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    await bucket.put("acme/b.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = {
      DB: db,
      UPLOADS_DEFAULT: bucket,
      FLAGS: { getBooleanValue: async () => true },
    } as unknown as Env;
    await recordContentHash(db, "acme", "a.png", SHA);
    await recordContentHash(db, "acme", "b.png", SHA);
    await recordContentHash(db, "acme", "c.png", SHA);
    await setServerFileMetadata(db, "acme", "b.png", { "ai.hold": "pending" });

    expect(
      await applyUploadHold(
        env,
        ws,
        "acme",
        "a.png",
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: SHA },
      ),
    ).toBe(true);
    const listed = async () => {
      const rows = await db
        .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`)
        .all<{ object_key: string }>();
      return (rows.results ?? []).map((row) => row.object_key);
    };
    const gated = [
      "acme/_internal/posters/a.png.jpg",
      "acme/_internal/posters/b.png.jpg",
      "acme/a.png",
      "acme/b.png",
    ];
    expect(await listed()).toEqual(gated);
    expect(hostedGateObjectKeys({ provider: "r2", bucket: "customer" }, "acme", ["a.png"])).toEqual(
      [],
    );

    expect(await approveUpload(env, ws, "acme", "a.png", "Member")).toEqual({ approved: true });
    expect(await listed()).toEqual([]);

    expect(await holdAgain(env, ws, "acme", "a.png", "Member")).toEqual({ held: true });
    expect(await listed()).toEqual(gated);
    sqlite.close();
  });

  it("backfills gate rows from held blobs and moved keys", async () => {
    const sqlite = new SqliteD1(MIGRATIONS.slice(0, 4));
    const db = database(sqlite);
    await recordContentHash(db, "acme", "held.png", SHA);
    await recordContentHash(db, "acme", "copy.png", SHA);
    await recordContentHash(db, "acme", "free.png", SHA);
    await setServerFileMetadata(db, "acme", "held.png", { "ai.hold": "pending" });
    await setServerFileMetadata(db, "acme", "copy.png", { "ai.hold": "pending" });
    await setServerFileMetadata(db, "acme", "moved.png", { "ai.hold.moved": "1" });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
      )
      .run("acme", SHA, "2026-10-28T00:00:00.000Z");
    sqlite.db.exec(readFileSync(resolve(API_ROOT, MIGRATIONS[4]!), "utf8"));

    const rows = await db
      .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`)
      .all<{ object_key: string }>();
    expect((rows.results ?? []).map((row) => row.object_key)).toEqual([
      "acme/_internal/posters/copy.png.jpg",
      "acme/_internal/posters/held.png.jpg",
      "acme/_internal/posters/moved.png.jpg",
      "acme/copy.png",
      "acme/held.png",
      "acme/moved.png",
    ]);
    sqlite.close();
  });

  it("drops a deleted held file from the held list", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/shot.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = { DB: db, UPLOADS_DEFAULT: bucket } as unknown as Env;
    await recordContentHash(db, "acme", "shot.png", SHA);
    await setServerFileMetadata(db, "acme", "shot.png", { "ai.hold": "pending" });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
      )
      .run("acme", SHA, "2026-10-28T00:00:00.000Z");
    expect(await listHeldKeys(env, "acme")).toEqual(["shot.png"]);
    await db
      .prepare(`INSERT INTO read_gate (lane, object_key) VALUES ('hosted', ?)`)
      .bind("acme/shot.png")
      .run();

    await deleteObject(env, ws, "shot.png", "acme");
    expect(await listHeldKeys(env, "acme")).toEqual([]);
    expect(
      await db.prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted'`).all(),
    ).toMatchObject({ results: [] });
    sqlite.close();
  });

  it("gates a held key when put, promote, or attach writes it again", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const env = envFor(sqlite, new FakeR2Bucket());
    await recordContentHash(db, "acme", "copy.png", SHA);
    await setServerFileMetadata(db, "acme", "copy.png", { "ai.hold": "pending" });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
      )
      .run("acme", SHA, "2026-10-28T00:00:00.000Z");

    await reholdIfHeld(env, ws, "acme", "copy.png");
    const row = await db
      .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' AND object_key = ?`)
      .bind("acme/copy.png")
      .first<{ object_key: string }>();
    expect(row).toEqual({ object_key: "acme/copy.png" });
    sqlite.close();
  });

  it("does not hide an identical upload the classifier did not hold", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const env = envFor(sqlite, new FakeR2Bucket());
    await recordContentHash(db, "acme", "held.png", SHA);
    await setServerFileMetadata(db, "acme", "held.png", { "ai.hold": "pending" });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
      )
      .run("acme", SHA, "2026-10-28T00:00:00.000Z");
    await recordContentHash(db, "acme", "copy.png", SHA);

    expect(
      await applyUploadHold(
        env,
        ws,
        "acme",
        "copy.png",
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: false, contentSha256: SHA },
      ),
    ).toBe(false);
    expect((await getFileMetadata(db, "acme", "copy.png"))["ai.hold"]).toBeUndefined();
    expect(await isKeyHeld(env, "acme", "copy.png")).toBe(false);
    expect(await isKeyHeld(env, "acme", "held.png")).toBe(true);
    sqlite.close();
  });

  it("keeps the read-gate worker off production routes", () => {
    const config = readFileSync(resolve(API_ROOT, "../read-gate/wrangler.jsonc"), "utf8");
    expect(config).not.toMatch(/"routes"\s*:/);
    expect(config).toContain("store.uploads.sh/*");
    expect(config).toContain("storage.uploads.sh/*");
    expect(config).toContain("embed.uploads.sh/*");
    expect(config).not.toContain("UPLOADS_HELD");
  });
});
