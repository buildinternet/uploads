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

/** Fake AUTH service binding: GET /internal/orgs + DELETE /internal/orgs/:slug. */
function fakeAuth(orgs: { id: string; slug: string }[]) {
  const deletedSlugs: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/internal/orgs") {
      return Response.json({ organizations: orgs });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/internal/orgs/")) {
      deletedSlugs.push(decodeURIComponent(url.pathname.slice("/internal/orgs/".length)));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as Fetcher["fetch"];
  return { fetch: fetch as unknown, deletedSlugs };
}

function fakeAuthFailing() {
  return {
    fetch: (async () => {
      throw new Error("AUTH unavailable");
    }) as Fetcher["fetch"],
  };
}

function makeEnv(opts: {
  kvRecords: Record<string, unknown>;
  bucket?: FakeR2Bucket;
  db: SqliteD1;
  auth?: { fetch: unknown };
}) {
  const { kvRecords, bucket = new FakeR2Bucket(), db, auth } = opts;
  const registry = fakeRegistry(kvRecords);
  const env = {
    REGISTRY: registry,
    BUCKET: bucket,
    DB: database(db),
    ...(auth ? { AUTH: auth } : {}),
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

  it("refuses to finalize a workspace whose purgeAt is unparseable", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      await bucket.put("f/one.png", new Uint8Array([1, 2, 3]));
      const record: WorkspaceRecord = {
        ...RECORD,
        deletedAt: new Date().toISOString(),
        purgeAt: "not-a-timestamp",
      };
      const { env, registry } = makeEnv({ kvRecords: { "ws:acme": record }, bucket, db: sqlite });

      const result = await runRetentionSweep(env);

      expect(result.workspacesFinalized).toHaveLength(1);
      expect(result.workspacesFinalized[0]?.error).toMatch(/unparseable purgeAt/);
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

describe("runRetentionSweep — orphan-org sweep (#250)", () => {
  it("keeps an org with a live ws record", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const auth = fakeAuth([{ id: "o1", slug: "acme" }]);
      const { env } = makeEnv({ kvRecords: { "ws:acme": RECORD }, db: sqlite, auth });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([]);
      expect(auth.deletedSlugs).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps an org for a soft-deleted-in-grace workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const auth = fakeAuth([{ id: "o1", slug: "acme" }]);
      const record: WorkspaceRecord = {
        ...RECORD,
        deletedAt: new Date().toISOString(),
        purgeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const { env } = makeEnv({ kvRecords: { "ws:acme": record }, db: sqlite, auth });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([]);
      expect(auth.deletedSlugs).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("deletes (force) an org whose ws record is a purged tombstone", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const auth = fakeAuth([{ id: "o1", slug: "acme" }]);
      const tombstone: PurgedTombstone = {
        status: "purged",
        name: "acme",
        purgedAt: new Date().toISOString(),
      };
      const { env } = makeEnv({ kvRecords: { "ws:acme": tombstone }, db: sqlite, auth });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([{ slug: "acme", deleted: true }]);
      expect(auth.deletedSlugs).toEqual(["acme"]);
    } finally {
      sqlite.close();
    }
  });

  it("deletes (force) an org with no ws key at all", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const auth = fakeAuth([{ id: "o1", slug: "orphan-org" }]);
      const { env } = makeEnv({ kvRecords: {}, db: sqlite, auth });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([{ slug: "orphan-org", deleted: true }]);
      expect(auth.deletedSlugs).toEqual(["orphan-org"]);
    } finally {
      sqlite.close();
    }
  });

  it("skips the communal/default workspace slug defensively", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const auth = fakeAuth([{ id: "o1", slug: "default" }]);
      const { env } = makeEnv({ kvRecords: {}, db: sqlite, auth });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([]);
      expect(auth.deletedSlugs).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("isolates an AUTH fetch failure — the sweep still completes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env } = makeEnv({
        kvRecords: { "ws:acme": RECORD },
        db: sqlite,
        auth: fakeAuthFailing(),
      });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toEqual([]);
      expect(result.workspacesScanned).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("isolates a per-org delete failure without dropping other orgs", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/internal/orgs") {
          return Response.json({
            organizations: [
              { id: "o1", slug: "bad-org" },
              { id: "o2", slug: "good-org" },
            ],
          });
        }
        if (req.method === "DELETE" && url.pathname === "/internal/orgs/bad-org") {
          throw new Error("delete failed");
        }
        if (req.method === "DELETE" && url.pathname === "/internal/orgs/good-org") {
          return new Response(null, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as Fetcher["fetch"];
      const { env } = makeEnv({ kvRecords: {}, db: sqlite, auth: { fetch } });

      const result = await runRetentionSweep(env);

      expect(result.orgsSwept).toHaveLength(2);
      const bad = result.orgsSwept.find((o) => o.slug === "bad-org");
      const good = result.orgsSwept.find((o) => o.slug === "good-org");
      expect(bad).toMatchObject({ slug: "bad-org", deleted: false });
      expect(bad?.error).toBeTruthy();
      expect(good).toEqual({ slug: "good-org", deleted: true });
    } finally {
      sqlite.close();
    }
  });
});
