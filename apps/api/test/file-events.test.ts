import { describe, expect, it } from "vitest";
import { recordContentHash } from "../src/content-hash";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { effectiveHold, isKeyHeld, listHeldKeys } from "../src/upload-hold-read";
import { approveUpload, holdAgain } from "../src/upload-hold-service";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const SHA = "ab".repeat(32);

const ws: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("file_events", () => {
  it("records a release override and leaves the safety flags", async () => {
    const sqlite = new SqliteD1([
      "migrations/20260713210559_file_metadata.sql",
      "migrations/20260724140000_file_content_hash.sql",
      "migrations/20261028120000_file_events.sql",
      "migrations/20261028140000_blob_hold.sql",
    ]);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/shots/a.png", new Uint8Array([1, 2, 3]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = { DB: db, UPLOADS_DEFAULT: bucket } as unknown as Env;
    await recordContentHash(db, "acme", "shots/a.png", SHA);
    await setServerFileMetadata(db, "acme", "shots/a.png", {
      "ai.hold": "pending",
      "ai.secret": "api_key",
      "ai.pii": "financial",
      "ai.rating": "explicit",
      "ai.content": "sexual",
    });
    expect(await approveUpload(env, ws, "acme", "shots/a.png", "Member")).toEqual({
      approved: true,
    });

    const stored = await getFileMetadata(db, "acme", "shots/a.png");
    expect(stored["ai.hold"]).toBe("pending");
    expect(stored["ai.hold.by"]).toBeUndefined();
    expect(stored["ai.hold.at"]).toBeUndefined();
    expect(stored["ai.secret"]).toBe("api_key");
    expect(stored["ai.pii"]).toBe("financial");
    expect(stored["ai.rating"]).toBe("explicit");
    expect(stored["ai.content"]).toBe("sexual");
    expect(await isKeyHeld(env, "acme", "shots/a.png")).toBe(false);
    expect(await listHeldKeys(env, "acme")).toEqual([]);
    expect(await effectiveHold(env, "acme", "shots/a.png", stored)).toMatchObject({
      hold: "approved",
      by: "Member",
    });

    expect(await holdAgain(env, ws, "acme", "shots/a.png", "Member")).toEqual({ held: true });
    const reheld = await getFileMetadata(db, "acme", "shots/a.png");
    expect(reheld["ai.hold"]).toBe("pending");
    expect(reheld["ai.secret"]).toBe("api_key");
    expect(await isKeyHeld(env, "acme", "shots/a.png")).toBe(true);
    expect(await listHeldKeys(env, "acme")).toEqual(["shots/a.png"]);
    const events = await db
      .prepare(
        `SELECT kind, action, actor, secret, content_sha256 FROM file_events
         WHERE workspace = ? AND object_key = ?
         ORDER BY id`,
      )
      .bind("acme", "shots/a.png")
      .all<{
        kind: string;
        action: string;
        actor: string;
        secret: string;
        content_sha256: string;
      }>();
    expect(events.results).toEqual([
      {
        kind: "override",
        action: "release",
        actor: "Member",
        secret: "api_key",
        content_sha256: SHA,
      },
      {
        kind: "override",
        action: "hold",
        actor: "Member",
        secret: "api_key",
        content_sha256: SHA,
      },
    ]);
    sqlite.close();
  });

  it("still approves when the event table is missing", async () => {
    const sqlite = new SqliteD1(["migrations/20260713210559_file_metadata.sql"]);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    await bucket.put("acme/a.png", new Uint8Array([1]), {
      customMetadata: { "content-sha256": SHA },
    });
    const env = { DB: db, UPLOADS_DEFAULT: bucket } as unknown as Env;
    await setServerFileMetadata(db, "acme", "a.png", {
      "ai.hold": "pending",
      "ai.secret": "api_key",
    });
    await expect(approveUpload(env, ws, "acme", "a.png", "Member")).rejects.toThrow(
      /no such table/,
    );
    const stored = await getFileMetadata(db, "acme", "a.png");
    expect(stored["ai.secret"]).toBe("api_key");
    expect(stored["ai.hold"]).toBe("pending");
    sqlite.close();
  });
});
