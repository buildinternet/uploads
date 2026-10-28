import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { recordContentHash } from "../src/content-hash";
import { deleteObject } from "../src/files-core";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { isKeyHeld, listHeldKeys } from "../src/upload-hold-read";
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

    await deleteObject(env, ws, "shot.png", "acme");
    expect(await listHeldKeys(env, "acme")).toEqual([]);
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
});
