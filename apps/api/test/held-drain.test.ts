import { describe, expect, it } from "vitest";
import { recordContentHash } from "../src/content-hash";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { drainHeldBucket } from "../src/held-drain";
import { contentSha256Hex } from "../src/provenance";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

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
  "migrations/20261018000000_file_metadata_ai_idx.sql",
  "migrations/20261028120000_file_events.sql",
  "migrations/20261028140000_blob_hold.sql",
  "migrations/20261028160000_read_gate.sql",
];

async function setup() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  const bucket = new FakeR2Bucket();
  const held = new FakeR2Bucket();
  const records: Record<string, WorkspaceRecord> = { "ws:acme": ws };
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    UPLOADS_HELD: held,
    REGISTRY: { get: async (key: string) => records[key] ?? null },
  } as unknown as Env;

  async function moved(workspace: string, key: string, state: "held" | "released") {
    const bytes = new TextEncoder().encode(`${workspace}/${key}`);
    const sha = await contentSha256Hex(bytes);
    await held.put(`${workspace}/${key}`, bytes, { httpMetadata: { contentType: "image/png" } });
    await recordContentHash(db, workspace, key, sha);
    await setServerFileMetadata(db, workspace, key, {
      "ai.hold": state === "held" ? "pending" : "approved",
      "ai.hold.moved": "1",
    });
    await sqlite.db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(workspace, sha, state, "2026-10-20T00:00:00.000Z");
    return bytes;
  }

  async function gates(): Promise<string[]> {
    const rows = await db
      .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`)
      .all<{ object_key: string }>();
    return (rows.results ?? []).map((row) => row.object_key);
  }

  return { sqlite, db, bucket, held, env, moved, gates };
}

describe("drainHeldBucket", () => {
  it("gates a still-held key, restores its bytes, and clears the flag", async () => {
    const t = await setup();
    const bytes = await t.moved("acme", "secret.png", "held");

    const result = await drainHeldBucket(t.env);

    expect(result).toMatchObject({
      scanned: 1,
      restoredHeld: 1,
      restoredReleased: 0,
      skipped: [],
      remaining: 0,
      bucketSample: [],
    });
    expect(await t.gates()).toEqual(["acme/_internal/posters/secret.png.jpg", "acme/secret.png"]);
    const restored = await t.bucket.get("acme/secret.png");
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(bytes);
    expect(await t.held.head("acme/secret.png")).toBeNull();
    const meta = await getFileMetadata(t.db, "acme", "secret.png");
    expect(meta["ai.hold.moved"]).toBeUndefined();
    expect(meta["ai.hold"]).toBe("pending");
    t.sqlite.close();
  });

  it("restores a released key without gate rows", async () => {
    const t = await setup();
    await t.moved("acme", "ok.png", "released");

    expect(await drainHeldBucket(t.env)).toMatchObject({ restoredReleased: 1, remaining: 0 });
    expect(await t.gates()).toEqual([]);
    expect(await t.bucket.head("acme/ok.png")).not.toBeNull();
    t.sqlite.close();
  });

  it("changes nothing on a dry run", async () => {
    const t = await setup();
    await t.moved("acme", "secret.png", "held");

    expect(await drainHeldBucket(t.env, { dryRun: true })).toMatchObject({
      dryRun: true,
      scanned: 1,
      restoredHeld: 0,
      remaining: 1,
      bucketSample: ["acme/secret.png"],
    });
    expect(await t.bucket.head("acme/secret.png")).toBeNull();
    expect(await t.gates()).toEqual([]);
    t.sqlite.close();
  });

  it("clears the flag when the held copy is gone but the public object exists", async () => {
    const t = await setup();
    await t.moved("acme", "half.png", "released");
    await t.bucket.put("acme/half.png", new Uint8Array([1]));
    await t.held.delete("acme/half.png");

    expect(await drainHeldBucket(t.env)).toMatchObject({ flagCleared: 1, remaining: 0 });
    expect((await getFileMetadata(t.db, "acme", "half.png"))["ai.hold.moved"]).toBeUndefined();
    t.sqlite.close();
  });

  it("skips a key whose workspace is gone and pages past it", async () => {
    const t = await setup();
    await t.moved("acme", "a.png", "held");
    await t.moved("gone", "b.png", "held");

    const first = await drainHeldBucket(t.env);
    expect(first).toMatchObject({
      restoredHeld: 1,
      skipped: [{ workspace: "gone", key: "b.png", reason: "workspace_missing" }],
      next: "gone/b.png",
      remaining: 0,
      bucketSample: ["gone/b.png"],
    });
    expect(await drainHeldBucket(t.env, { after: first.next! })).toMatchObject({
      scanned: 0,
      remaining: 0,
    });
    t.sqlite.close();
  });
});
