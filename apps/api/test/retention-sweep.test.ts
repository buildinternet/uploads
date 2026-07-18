import { describe, expect, it } from "vitest";
import { runRetentionSweep } from "../src/retention-sweep";
import type { PurgedTombstone, WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
];

const RECORD: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "BUCKET",
  publicBaseUrl: "https://storage.uploads.sh",
};

/** Fake REGISTRY: paginated `ws:` list plus get/put/delete over an in-memory Map. */
function fakeRegistry(records: Record<string, unknown>) {
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
    list: (async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })) as unknown as KVNamespace["list"],
  };
}

function makeEnv(opts: {
  kvRecords: Record<string, unknown>;
  bucket?: FakeR2Bucket;
  db: SqliteD1;
}) {
  const { kvRecords, bucket = new FakeR2Bucket(), db } = opts;
  const registry = fakeRegistry(kvRecords);
  const env = {
    REGISTRY: registry,
    BUCKET: bucket,
    DB: database(db),
  } as unknown as Env;
  return { env, registry, bucket };
}

describe("runRetentionSweep — soft-delete finalization (#247)", () => {
  it("fully tears down a past-purgeAt workspace and writes a purged tombstone", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("f/one.png", new Uint8Array([1, 2, 3]));
      const record: WorkspaceRecord = {
        ...RECORD,
        deletedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        purgeAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const { env, registry } = makeEnv({ kvRecords: { "ws:acme": record }, bucket, db: sqlite });

      const result = await runRetentionSweep(env);

      expect(result.workspacesFinalized).toHaveLength(1);
      expect(result.workspacesFinalized[0]).toMatchObject({ workspace: "acme", objectsDeleted: 1 });
      expect(bucket.store.size).toBe(0);

      const stored = registry.store.get("ws:acme") as PurgedTombstone;
      expect(stored.status).toBe("purged");
      expect(stored.name).toBe("acme");
      expect(stored.deletedAt).toBe(record.deletedAt);
      // Slug still "taken" — the key is non-null.
      expect(registry.store.has("ws:acme")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("leaves a not-yet-due soft-deleted workspace untouched", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("f/one.png", new Uint8Array([1, 2, 3]));
      const record: WorkspaceRecord = {
        ...RECORD,
        deletedAt: new Date().toISOString(),
        purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const { env, registry } = makeEnv({ kvRecords: { "ws:acme": record }, bucket, db: sqlite });

      const result = await runRetentionSweep(env);

      expect(result.workspacesFinalized).toHaveLength(0);
      expect(bucket.store.has("f/one.png")).toBe(true);
      expect(registry.store.get("ws:acme")).toEqual(record);
    } finally {
      sqlite.close();
    }
  });

  it("skips a purged tombstone harmlessly on a later sweep", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const tombstone: PurgedTombstone = {
        status: "purged",
        name: "acme",
        purgedAt: new Date().toISOString(),
      };
      const { env, registry } = makeEnv({ kvRecords: { "ws:acme": tombstone }, db: sqlite });

      const result = await runRetentionSweep(env);

      expect(result.workspacesFinalized).toHaveLength(0);
      expect(result.purged).toHaveLength(0);
      expect(registry.store.get("ws:acme")).toEqual(tombstone);
    } finally {
      sqlite.close();
    }
  });

  it("still runs the normal retentionDays purge for workspaces without deletedAt", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("old.png", new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });
      bucket.setUploaded("old.png", new Date("2020-01-01T00:00:00Z"));
      const record: WorkspaceRecord = { ...RECORD, retentionDays: 30 };
      const { env } = makeEnv({ kvRecords: { "ws:acme": record }, bucket, db: sqlite });

      const result = await runRetentionSweep(env);

      expect(result.workspacesWithRetention).toBe(1);
      expect(result.purged).toEqual([{ workspace: "acme", deleted: 1, freedBytes: 3 }]);
      expect(bucket.store.has("old.png")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
