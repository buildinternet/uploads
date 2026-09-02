import { describe, expect, it } from "vitest";
import { attachmentRow, recordAttachment } from "../src/github-attachment-index";
import { teardownWorkspace } from "../src/workspace-teardown";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260730170533_delete_usage_claims.sql",
  "migrations/20260903120000_github_attachments.sql",
];

// Prefixed shared-bucket record — mirrors retention-sweep.test.ts's RECORD.
const RECORD: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "BUCKET",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

/** Fake REGISTRY: get/put/delete over an in-memory Map. */
function fakeRegistry(records: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(records));
  return {
    store,
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, JSON.parse(value));
    }) as unknown as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as unknown as KVNamespace["delete"],
  };
}

/** Fake AUTH service binding: org delete is best-effort, so any response works. */
function fakeAuth() {
  return {
    fetch: (async () => new Response(null, { status: 204 })) as Fetcher["fetch"],
  };
}

function makeEnv(opts: {
  kvRecords?: Record<string, unknown>;
  bucket?: FakeR2Bucket;
  db: SqliteD1;
}) {
  const { kvRecords = {}, bucket = new FakeR2Bucket(), db } = opts;
  const registry = fakeRegistry(kvRecords);
  const env = {
    REGISTRY: registry,
    BUCKET: bucket,
    DB: database(db),
    AUTH: fakeAuth(),
  } as unknown as Env;
  return { env, registry, bucket };
}

async function seedUsage(sqlite: SqliteD1, workspace: string) {
  const db = database(sqlite);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
       VALUES (?, 100, 1, 1, ?, ?)`,
    )
    .bind(workspace, now, now)
    .run();
  await db
    .prepare(`INSERT INTO delete_usage_claims (workspace, object_key, claimed_at) VALUES (?, ?, ?)`)
    .bind(workspace, `${workspace}/f/one.png`, now)
    .run();
}

async function countRows(sqlite: SqliteD1, table: string, workspace: string): Promise<number> {
  const db = database(sqlite);
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace = ?`)
    .bind(workspace)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

describe("teardownWorkspace — usage ledger cleanup (#006)", () => {
  it("deletes workspace_usage and delete_usage_claims rows for the torn-down workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedUsage(sqlite, "acme");
      await seedUsage(sqlite, "other");
      const { env } = makeEnv({ kvRecords: { "ws:acme": RECORD }, db: sqlite });

      await teardownWorkspace(env, "acme", RECORD, { reason: "test" });

      expect(await countRows(sqlite, "workspace_usage", "acme")).toBe(0);
      expect(await countRows(sqlite, "delete_usage_claims", "acme")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("leaves other workspaces' usage rows untouched", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedUsage(sqlite, "acme");
      await seedUsage(sqlite, "other");
      const { env } = makeEnv({ kvRecords: { "ws:acme": RECORD }, db: sqlite });

      await teardownWorkspace(env, "acme", RECORD, { reason: "test" });

      expect(await countRows(sqlite, "workspace_usage", "other")).toBe(1);
      expect(await countRows(sqlite, "delete_usage_claims", "other")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("clears usage rows on the tombstone path too", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seedUsage(sqlite, "acme");
      const { env } = makeEnv({ kvRecords: { "ws:acme": RECORD }, db: sqlite });

      await teardownWorkspace(env, "acme", RECORD, {
        reason: "test",
        replaceWithTombstone: true,
      });

      expect(await countRows(sqlite, "workspace_usage", "acme")).toBe(0);
      expect(await countRows(sqlite, "delete_usage_claims", "acme")).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("teardownWorkspace — attachment index cleanup (issue #934)", () => {
  it("clears this workspace's github_attachments rows and no other's", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const objectKey = "gh/acme/web/pull/12/hero.png";
      for (const workspace of ["acme", "other"]) {
        await recordAttachment(db, {
          workspace,
          repo: "acme/web",
          kind: "pull",
          num: 12,
          objectKey,
          prefixId: null,
          laneId: null,
          source: "put",
        });
      }
      const { env } = makeEnv({ kvRecords: { "ws:acme": RECORD }, db: sqlite });

      await teardownWorkspace(env, "acme", RECORD, { reason: "test" });

      expect(await attachmentRow(db, "acme", objectKey)).toBeNull();
      expect(await attachmentRow(db, "other", objectKey)).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
