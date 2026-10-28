import { describe, expect, it } from "vitest";
import { recordContentHash } from "../src/content-hash";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { releaseHolds } from "../src/upload-hold-service";
import { countHeldByWorkspace, listHeldAcrossWorkspaces } from "../src/upload-hold-read";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20261018000000_file_metadata_ai_idx.sql",
  "migrations/20261028120000_file_events.sql",
  "migrations/20261028140000_blob_hold.sql",
];

function makeEnv() {
  const sqlite = new SqliteD1(MIGRATIONS, []);
  const registry = new FakeKv();
  const bucket = new FakeR2Bucket();
  const record = (name: string): WorkspaceRecord => ({
    provider: "r2",
    bucket: "shared",
    binding: "UPLOADS_DEFAULT",
    prefix: `${name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
  });
  const env = {
    DB: database(sqlite),
    REGISTRY: registry,
    UPLOADS_DEFAULT: bucket,
  } as unknown as Env;
  return { env, registry, record, bucket };
}

async function hold(env: Env, workspace: string, key: string) {
  const sha = "ab".repeat(32);
  await recordContentHash(env.DB, workspace, key, sha);
  await env.DB.prepare(
    `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)
     ON CONFLICT(workspace, content_sha256) DO NOTHING`,
  )
    .bind(workspace, sha, "2026-10-28T00:00:00.000Z")
    .run();
  await setServerFileMetadata(env.DB, workspace, key, { "ai.hold": "pending" });
}

describe("operator hold release", () => {
  it("counts and lists pending holds across workspaces", async () => {
    const { env } = makeEnv();
    await hold(env, "acme", "a.png");
    await hold(env, "acme", "b.png");
    await hold(env, "beta", "c.png");
    await setServerFileMetadata(env.DB, "beta", "d.png", { "ai.hold": "approved" });

    expect(await countHeldByWorkspace(env)).toEqual([
      { workspace: "acme", count: 2 },
      { workspace: "beta", count: 1 },
    ]);
    expect(await listHeldAcrossWorkspaces(env, { workspace: "beta", limit: 10 })).toEqual([
      { workspace: "beta", objectKey: "c.png" },
    ]);
  });

  it("approves every pending hold, or one workspace's", async () => {
    const { env, registry, record, bucket } = makeEnv();
    await registry.put("ws:acme", JSON.stringify(record("acme")));
    await registry.put("ws:beta", JSON.stringify(record("beta")));
    const sha = { "content-sha256": "ab".repeat(32) };
    await bucket.put("acme/a.png", new Uint8Array([1]), { customMetadata: sha });
    await bucket.put("beta/c.png", new Uint8Array([2]), { customMetadata: sha });
    await hold(env, "acme", "a.png");
    await hold(env, "beta", "c.png");

    expect(await releaseHolds(env, { workspace: "beta" })).toEqual({
      released: 1,
      failed: 0,
      remaining: 0,
    });
    expect((await getFileMetadata(env.DB, "acme", "a.png"))["ai.hold"]).toBe("pending");

    expect(await releaseHolds(env)).toEqual({ released: 1, failed: 0, remaining: 0 });
    expect((await getFileMetadata(env.DB, "acme", "a.png"))["ai.hold"]).toBe("pending");
  });

  it("counts a hold it cannot release and leaves it held", async () => {
    const { env } = makeEnv();
    await hold(env, "gone", "a.png");
    expect(await releaseHolds(env)).toEqual({ released: 0, failed: 1, remaining: 1 });
  });
});
