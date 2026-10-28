/**
 * Promote and attach copies of a hosted upload. The copy records
 * `ai.copied-from` when the source is not held, so a later hold gates that
 * key. A source that is already held is not copied. Bytes stay in the
 * public bucket.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { recordContentHash } from "../src/content-hash";
import { getFileMetadata, replaceFileMetadata } from "../src/file-metadata";
import { attachExistingObject } from "../src/github-attach";
import { promoteBranchAttachments } from "../src/github-promote";
import { contentSha256Hex } from "../src/provenance";
import { applyUploadHold } from "../src/upload-hold-service";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const API_ROOT = fileURLToPath(new NodeURL("../", import.meta.url));
const MIGRATIONS = readdirSync(resolve(API_ROOT, "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => `migrations/${name}`);

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const BRANCH = "feat-x";
const NUM = 7;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const ws: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: PREFIX,
  publicBaseUrl: "https://storage.uploads.sh",
};

function stagedKey(filename: string): string {
  return `gh/acme/web/branch/${BRANCH}/${filename}`;
}

function pullKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

async function envFor() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  const bucket = new FakeR2Bucket();
  const held = new FakeR2Bucket();
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    UPLOADS_HELD: held,
    FLAGS: { getBooleanValue: async () => true },
  } as unknown as Env;
  return { sqlite, db, bucket, held, env };
}

async function gateRows(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`)
    .all<{ object_key: string }>();
  return (rows.results ?? []).map((row) => row.object_key);
}

async function seedStaged(bucket: FakeR2Bucket, db: D1Database, filename: string) {
  const key = stagedKey(filename);
  await bucket.put(`${PREFIX}${key}`, PNG, { httpMetadata: { contentType: "image/png" } });
  await replaceFileMetadata(db, WS, key, {
    "gh.repo": REPO,
    "gh.kind": "branch",
    "gh.branch": BRANCH,
    "gh.status": "staged",
    "gh.staged-at": new Date().toISOString(),
  });
  return key;
}

describe("promote and attach copies follow a hosted hold", () => {
  it("gates a promote that landed before the hold, and leaves the bytes in place", async () => {
    const { sqlite, db, bucket, held, env } = await envFor();
    const source = await seedStaged(bucket, db, "hero.png");
    const dest = pullKey("hero.png");
    const sha = await contentSha256Hex(PNG);

    const promoted = await promoteBranchAttachments(env, ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });
    expect(promoted.promoted).toEqual([dest]);
    expect((await getFileMetadata(db, WS, dest))["ai.copied-from"]).toBe(source);
    expect((await getFileMetadata(db, WS, dest))["ai.hold"]).toBeUndefined();

    await recordContentHash(db, WS, "unrelated.png", sha);
    expect(
      await applyUploadHold(
        env,
        ws,
        WS,
        source,
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: sha },
      ),
    ).toBe(true);

    expect(await gateRows(db)).toEqual([
      `${PREFIX}_internal/posters/${source}.jpg`,
      `${PREFIX}_internal/posters/${dest}.jpg`,
      `${PREFIX}${source}`,
      `${PREFIX}${dest}`,
    ]);
    expect((await getFileMetadata(db, WS, dest))["ai.hold"]).toBe("pending");
    expect((await getFileMetadata(db, WS, "unrelated.png"))["ai.hold"]).toBeUndefined();
    expect(bucket.store.has(`${PREFIX}${source}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${dest}`)).toBe(true);
    expect(held.store.size).toBe(0);
    sqlite.close();
  });

  it("does not copy a promote that lands after the hold", async () => {
    const { sqlite, db, bucket, env } = await envFor();
    const source = await seedStaged(bucket, db, "hero.png");
    const dest = pullKey("hero.png");
    const sha = await contentSha256Hex(PNG);
    await recordContentHash(db, WS, source, sha);
    expect(
      await applyUploadHold(
        env,
        ws,
        WS,
        source,
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: sha },
      ),
    ).toBe(true);

    const promoted = await promoteBranchAttachments(env, ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });
    expect(promoted.promoted).toEqual([]);
    expect(promoted.skipped).toEqual([{ key: source, reason: "held" }]);
    expect(bucket.store.has(`${PREFIX}${dest}`)).toBe(false);
    const rows = await gateRows(db);
    expect(rows).toContain(`${PREFIX}${source}`);
    expect(rows).not.toContain(`${PREFIX}${dest}`);
    sqlite.close();
  });

  it("gates an attach that landed before the hold", async () => {
    const { sqlite, db, bucket, held, env } = await envFor();
    const source = "f/abc/shot.png";
    const dest = pullKey("shot.png");
    const sha = await contentSha256Hex(PNG);
    await bucket.put(`${PREFIX}${source}`, PNG, { httpMetadata: { contentType: "image/png" } });

    const attached = await attachExistingObject(env, ws, WS, {
      source,
      target: { repo: REPO, kind: "pull", num: NUM },
    });
    expect(attached.key).toBe(dest);
    expect((await getFileMetadata(db, WS, dest))["ai.copied-from"]).toBe(source);

    expect(
      await applyUploadHold(
        env,
        ws,
        WS,
        source,
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: sha },
      ),
    ).toBe(true);
    expect((await getFileMetadata(db, WS, dest))["ai.hold"]).toBe("pending");
    expect(await gateRows(db)).toEqual(
      expect.arrayContaining([`${PREFIX}${source}`, `${PREFIX}${dest}`]),
    );
    expect(bucket.store.has(`${PREFIX}${source}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${dest}`)).toBe(true);
    expect(held.store.size).toBe(0);
    sqlite.close();
  });

  it("does not copy an attach that lands after the hold", async () => {
    const { sqlite, db, bucket, env } = await envFor();
    const source = "f/abc/shot.png";
    const dest = pullKey("shot.png");
    const sha = await contentSha256Hex(PNG);
    await bucket.put(`${PREFIX}${source}`, PNG, { httpMetadata: { contentType: "image/png" } });
    await recordContentHash(db, WS, source, sha);
    expect(
      await applyUploadHold(
        env,
        ws,
        WS,
        source,
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: sha },
      ),
    ).toBe(true);

    await expect(
      attachExistingObject(env, ws, WS, {
        source,
        target: { repo: REPO, kind: "pull", num: NUM },
      }),
    ).rejects.toMatchObject({ code: "held" });
    expect(bucket.store.has(`${PREFIX}${dest}`)).toBe(false);
    sqlite.close();
  });
});
