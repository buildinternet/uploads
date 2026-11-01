import { describe, expect, it } from "vitest";
import { recordContentHash } from "../src/content-hash";
import { setServerFileMetadata } from "../src/file-metadata";
import { deleteReadGateForWorkspace, deleteReadGateKeys } from "../src/read-gate";
import { blockUrl, listUrlBlocks, parseBlockTarget, unblockUrl } from "../src/url-block";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20261018000000_file_metadata_ai_idx.sql",
  "migrations/20261028120000_file_events.sql",
  "migrations/20261028140000_blob_hold.sql",
  "migrations/20261028160000_read_gate.sql",
  "migrations/20261101120000_url_block.sql",
];

function makeEnv() {
  const sqlite = new SqliteD1(MIGRATIONS, []);
  const env = { DB: database(sqlite) } as unknown as Env;
  return { env, sqlite };
}

async function gateKeys(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`,
  ).all<{ object_key: string }>();
  return (results ?? []).map((row) => row.object_key);
}

async function hold(env: Env, workspace: string, key: string) {
  const sha = "cd".repeat(32);
  await recordContentHash(env.DB, workspace, key, sha);
  await env.DB.prepare(
    `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at) VALUES (?, ?, 'held', NULL, ?)`,
  )
    .bind(workspace, sha, "2026-11-01T00:00:00.000Z")
    .run();
  await setServerFileMetadata(env.DB, workspace, key, { "ai.hold": "pending" });
}

describe("parseBlockTarget", () => {
  it("reads the object key the read gate looks up", () => {
    expect(parseBlockTarget({}, "https://embed.uploads.sh/acme/shots/a%20b.png?x=1")).toEqual({
      url: "https://embed.uploads.sh/acme/shots/a b.png",
      objectKey: "acme/shots/a b.png",
      workspace: "acme",
      key: "shots/a b.png",
    });
    expect(
      parseBlockTarget({}, "https://storage.uploads.sh/cdn-cgi/image/format=png/acme/a.avif")
        .objectKey,
    ).toBe("acme/a.avif");
  });

  it("rejects other hosts and URLs with no file", () => {
    expect(() => parseBlockTarget({}, "https://example.com/acme/a.png")).toThrow(/hosted host/);
    expect(() => parseBlockTarget({}, "https://storage.uploads.sh/acme")).toThrow(
      /point at a file/,
    );
    expect(() => parseBlockTarget({}, "not a url")).toThrow(/full URL/);
  });
});

describe("operator URL blocks", () => {
  it("blocks the key and its poster, and lists the URL once", async () => {
    const { env } = makeEnv();
    const target = parseBlockTarget({}, "https://storage.uploads.sh/acme/clip.mp4");
    await blockUrl(env, target, "DMCA notice", "ops@uploads.sh", new Date("2026-11-01T12:00:00Z"));

    expect(await gateKeys(env)).toEqual(["acme/_internal/posters/clip.mp4.jpg", "acme/clip.mp4"]);
    expect(await listUrlBlocks(env)).toEqual([
      {
        url: "https://storage.uploads.sh/acme/clip.mp4",
        objectKey: "acme/clip.mp4",
        reason: "DMCA notice",
        blockedBy: "ops@uploads.sh",
        blockedAt: "2026-11-01T12:00:00.000Z",
      },
    ]);
  });

  it("survives file delete and workspace-scoped gate deletes until unblocked", async () => {
    const { env } = makeEnv();
    const target = parseBlockTarget({}, "https://storage.uploads.sh/acme/a.png");
    await blockUrl(env, target, "abuse", "ops@uploads.sh");

    await deleteReadGateKeys(env.DB, ["acme/a.png", "acme/_internal/posters/a.png.jpg"]);
    expect(await gateKeys(env)).toEqual(["acme/_internal/posters/a.png.jpg", "acme/a.png"]);

    expect(await unblockUrl(env, target, "ops@uploads.sh")).toEqual({
      removed: true,
      stillHeld: false,
    });
    expect(await gateKeys(env)).toEqual([]);
    expect(await listUrlBlocks(env)).toEqual([]);
    expect((await unblockUrl(env, target, "ops@uploads.sh")).removed).toBe(false);
  });

  it("keeps the gate rows on unblock while the file is held", async () => {
    const { env } = makeEnv();
    await hold(env, "acme", "secret.png");
    const target = parseBlockTarget({}, "https://storage.uploads.sh/acme/secret.png");
    await blockUrl(env, target, "legal", "ops@uploads.sh");

    expect(await unblockUrl(env, target, "ops@uploads.sh")).toEqual({
      removed: true,
      stillHeld: true,
    });
    expect(await gateKeys(env)).toEqual([
      "acme/_internal/posters/secret.png.jpg",
      "acme/secret.png",
    ]);
  });

  it("workspace teardown drops blocks with the gate rows", async () => {
    const { env } = makeEnv();
    await blockUrl(env, parseBlockTarget({}, "https://storage.uploads.sh/acme/a.png"), "x", "o");
    await blockUrl(env, parseBlockTarget({}, "https://storage.uploads.sh/beta/b.png"), "y", "o");

    await deleteReadGateForWorkspace(env.DB, "acme");

    expect(await gateKeys(env)).toEqual(["beta/_internal/posters/b.png.jpg", "beta/b.png"]);
    expect((await listUrlBlocks(env)).map((b) => b.objectKey)).toEqual(["beta/b.png"]);
  });
});
