import { describe, expect, it } from "vitest";
import { attachmentRow, recordAttachment } from "../src/github-attachment-index";
import { purgeExpiredObjects } from "../src/retention";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260903120000_github_attachments.sql",
];

// Prefixed shared-bucket record — the common case (see retention-sweep.test.ts).
const RECORD: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "BUCKET",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
  retentionDays: 1,
};

async function insertMetadataRow(
  db: D1Database,
  workspace: string,
  objectKey: string,
  metaKey = "gh.repo",
  metaValue = "acme/web",
) {
  await db
    .prepare(
      `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(workspace, objectKey, metaKey, metaValue, new Date().toISOString())
    .run();
}

async function metadataRowCount(db: D1Database, workspace: string, objectKey: string) {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM file_metadata WHERE workspace = ? AND object_key = ?`)
    .bind(workspace, objectKey)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function makeEnv(bucket: FakeR2Bucket, sqlite: SqliteD1) {
  return {
    BUCKET: bucket,
    DB: database(sqlite),
  } as unknown as Env;
}

describe("purgeExpiredObjects — file_metadata cleanup (plan 007)", () => {
  it("deletes file_metadata rows for expired objects it purges", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("acme/old.png", new Uint8Array([1, 2, 3]));
      bucket.setUploaded("acme/old.png", new Date("2020-01-01T00:00:00Z"));
      await bucket.put("acme/fresh.png", new Uint8Array([4, 5, 6]));

      const db = database(sqlite);
      await insertMetadataRow(db, "acme", "old.png");
      await insertMetadataRow(db, "acme", "fresh.png");
      await insertMetadataRow(db, "other-ws", "old.png");

      const env = makeEnv(bucket, sqlite);
      const result = await purgeExpiredObjects(env, RECORD, "acme");

      expect(result).toMatchObject({ deleted: 1, keys: ["old.png"] });
      expect(bucket.store.has("acme/old.png")).toBe(false);

      // Expired object's row is gone.
      expect(await metadataRowCount(db, "acme", "old.png")).toBe(0);

      // Fresh object's row and the other workspace's row survive.
      expect(await metadataRowCount(db, "acme", "fresh.png")).toBe(1);
      expect(await metadataRowCount(db, "other-ws", "old.png")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("leaves all file_metadata rows intact when nothing is expired", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("acme/fresh.png", new Uint8Array([4, 5, 6]));

      const db = database(sqlite);
      await insertMetadataRow(db, "acme", "fresh.png");
      await insertMetadataRow(db, "other-ws", "fresh.png");

      const env = makeEnv(bucket, sqlite);
      const result = await purgeExpiredObjects(env, RECORD, "acme");

      expect(result).toMatchObject({ deleted: 0, keys: [] });
      expect(await metadataRowCount(db, "acme", "fresh.png")).toBe(1);
      expect(await metadataRowCount(db, "other-ws", "fresh.png")).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("purgeExpiredObjects — attachment index cleanup (issue #934)", () => {
  it("deletes github_attachments rows for expired attachments it purges", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const bucket = new FakeR2Bucket();
      const oldKey = "gh/acme/web/pull/12/old.png";
      const freshKey = "gh/acme/web/pull/12/fresh.png";
      await bucket.put(`acme/${oldKey}`, new Uint8Array([1, 2, 3]));
      bucket.setUploaded(`acme/${oldKey}`, new Date("2020-01-01T00:00:00Z"));
      await bucket.put(`acme/${freshKey}`, new Uint8Array([1, 2, 3]));
      for (const objectKey of [oldKey, freshKey]) {
        await recordAttachment(db, {
          workspace: "acme",
          repo: "acme/web",
          kind: "pull",
          num: 12,
          objectKey,
          prefixId: null,
          laneId: null,
          source: "put",
        });
      }

      await purgeExpiredObjects(makeEnv(bucket, sqlite), RECORD, "acme");

      expect(await attachmentRow(db, "acme", oldKey)).toBeNull();
      expect(await attachmentRow(db, "acme", freshKey)).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("issues no index DELETE for a batch that holds no attachment keys", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      // Neither key can ever have an index row: a bare upload, and a
      // branch-staged key (not an attachment until promoted).
      for (const key of ["shots/old.png", "gh/acme/web/branch/feat-x/old.png"]) {
        await bucket.put(`acme/${key}`, new Uint8Array([1, 2, 3]));
        bucket.setUploaded(`acme/${key}`, new Date("2020-01-01T00:00:00Z"));
      }

      const statements: string[] = [];
      const db = database(sqlite);
      const spyDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              statements.push(sql.replace(/\s+/g, " ").trim());
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const result = await purgeExpiredObjects(
        { BUCKET: bucket, DB: spyDb } as unknown as Env,
        RECORD,
        "acme",
      );

      expect(result).toMatchObject({ deleted: 2 });
      expect(statements.some((sql) => sql.includes("DELETE FROM github_attachments"))).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
