import { describe, expect, it } from "vitest";
import {
  ABANDONED_MAX_AGE_DAYS,
  PROMOTED_MAX_AGE_DAYS,
  runStagingReaper,
  STAGING_REAP_SCAN_LIMIT,
  STAGING_REAPER_CURSOR_KEY,
} from "../src/staging-reaper";
import { getFileMetadata, replaceFileMetadata } from "../src/file-metadata";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
  // Covering (meta_key, meta_value, workspace, object_key) index for the reaper
  // scan. DROP IF EXISTS is a no-op when the short lookup index was never applied.
  "migrations/20260722180000_file_metadata_value_covering_idx.sql",
];

const WS = "acme";
const RECORD: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "BUCKET",
  publicBaseUrl: "https://storage.uploads.sh",
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fake REGISTRY: get/put/delete over an in-memory Map (workspace records + reaper cursor). */
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
  };
}

function makeEnv(opts: { db: SqliteD1; bucket?: FakeR2Bucket; workspaces?: string[] }) {
  const { db, bucket = new FakeR2Bucket() } = opts;
  const workspaces = opts.workspaces ?? [WS];
  const registry = fakeRegistry(Object.fromEntries(workspaces.map((w) => [`ws:${w}`, RECORD])));
  const env = {
    REGISTRY: registry,
    BUCKET: bucket,
    DB: database(db),
  } as unknown as Env;
  return { env, bucket, registry };
}

function branchKey(workspace: string, branch: string, filename: string): string {
  return `gh/${workspace}/repo/branch/${branch}/${filename}`;
}

async function seed(
  db: SqliteD1,
  bucket: FakeR2Bucket,
  workspace: string,
  key: string,
  tags: Record<string, string>,
) {
  await bucket.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
  await replaceFileMetadata(database(db), workspace, key, tags);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

describe("runStagingReaper", () => {
  it("deletes a promoted staging file older than the promoted max age", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-x", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-x",
        "gh.staged-at": daysAgo(PROMOTED_MAX_AGE_DAYS + 10),
        "gh.promoted-to": "pull/12",
        "gh.promoted-at": daysAgo(PROMOTED_MAX_AGE_DAYS + 1),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([{ workspace: WS, key, reason: "promoted" }]);
      expect(bucket.store.has(key)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("keeps a recently promoted staging file", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-x", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-x",
        "gh.staged-at": daysAgo(20),
        "gh.promoted-to": "pull/12",
        "gh.promoted-at": daysAgo(1),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([]);
      expect(bucket.store.has(key)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("deletes an abandoned staging file older than the abandoned max age", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-y", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-y",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([{ workspace: WS, key, reason: "abandoned" }]);
      expect(bucket.store.has(key)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("keeps a recently staged, never-promoted file", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-y", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-y",
        "gh.staged-at": daysAgo(5),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([]);
      expect(bucket.store.has(key)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("never deletes on a missing or unparsable gh.staged-at", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const missing = branchKey(WS, "feat-z", "no-staged-at.png");
      const bad = branchKey(WS, "feat-z", "bad-staged-at.png");
      await seed(sqlite, bucket, WS, missing, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-z",
      });
      await seed(sqlite, bucket, WS, bad, {
        "gh.kind": "branch",
        "gh.repo": "acme/repo",
        "gh.branch": "feat-z",
        "gh.staged-at": "not-a-timestamp",
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([]);
      expect(bucket.store.has(missing)).toBe(true);
      expect(bucket.store.has(bad)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("leaves non-branch gh.* files untouched", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const prKey = `gh/${WS}/repo/pull/12/shot.png`;
      await seed(sqlite, bucket, WS, prKey, {
        "gh.kind": "pull",
        "gh.repo": "acme/repo",
        "gh.number": "12",
        "gh.promoted-at": daysAgo(PROMOTED_MAX_AGE_DAYS + 30),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([]);
      expect(bucket.store.has(prKey)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("belt-and-braces: refuses to delete a gh.kind=branch row whose key isn't shaped like branch staging", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      // Same tags as an eligible abandoned row, but the key doesn't match the
      // `gh/<owner>/<repo>/branch/<branch>/<file>` shape — must be skipped
      // even though the D1 tags alone would say "delete me".
      const key = "not-a-branch-staging-key.png";
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(bucket.store.has(key)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("bounds deletions to the scan cap per run", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      const count = STAGING_REAP_SCAN_LIMIT + 5;
      for (let i = 0; i < count; i++) {
        const key = branchKey(WS, "feat-many", `shot-${i}.png`);
        await seed(sqlite, bucket, WS, key, {
          "gh.kind": "branch",
          "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
        });
      }
      const { env } = makeEnv({ db: sqlite, bucket });

      const result = await runStagingReaper(env);

      expect(result.scanned).toBe(STAGING_REAP_SCAN_LIMIT);
      expect(result.deleted.length).toBe(STAGING_REAP_SCAN_LIMIT);
    } finally {
      sqlite.close();
    }
  });

  it("isolates a per-object delete failure without dropping other candidates", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      const okKey = branchKey(WS, "feat-ok", "shot.png");
      const badKey = branchKey("ghost-ws", "feat-bad", "shot.png");
      await seed(sqlite, bucket, WS, okKey, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });
      // A row scoped to a workspace with no `ws:` registry record — the
      // reaper must record it as an error and keep going.
      await replaceFileMetadata(database(sqlite), "ghost-ws", badKey, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });
      const { env } = makeEnv({ db: sqlite, bucket, workspaces: [WS] });

      const result = await runStagingReaper(env);

      expect(result.deleted).toEqual([{ workspace: WS, key: okKey, reason: "abandoned" }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ workspace: "ghost-ws", key: badKey });
    } finally {
      sqlite.close();
    }
  });

  it("leaves D1 metadata behind once the row is deleted", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-y", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });

      await runStagingReaper(env);

      const meta = await getFileMetadata(database(sqlite), WS, key);
      expect(meta).toEqual({});
    } finally {
      sqlite.close();
    }
  });

  it("advances a keyset cursor so later pages can reap past a young alphabetical head", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      // Young (non-reapable) keys that sort *before* one old abandoned object.
      // A single run without a cursor only sees the young head; the second run
      // must resume via the stored cursor to reach the old key.
      for (let i = 0; i < STAGING_REAP_SCAN_LIMIT; i++) {
        const key = branchKey(WS, "aaa", `shot-${String(i).padStart(3, "0")}.png`);
        await seed(sqlite, bucket, WS, key, {
          "gh.kind": "branch",
          "gh.staged-at": daysAgo(1),
        });
      }
      const oldKey = branchKey(WS, "zzz", "old.png");
      await seed(sqlite, bucket, WS, oldKey, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });
      const { env, registry } = makeEnv({ db: sqlite, bucket });

      const first = await runStagingReaper(env);
      expect(first.scanned).toBe(STAGING_REAP_SCAN_LIMIT);
      expect(first.deleted).toEqual([]);
      expect(first.nextAfter).toEqual({
        workspace: WS,
        key: branchKey(
          WS,
          "aaa",
          `shot-${String(STAGING_REAP_SCAN_LIMIT - 1).padStart(3, "0")}.png`,
        ),
      });
      expect(registry.store.get(STAGING_REAPER_CURSOR_KEY)).toEqual(first.nextAfter);
      expect(bucket.store.has(oldKey)).toBe(true);

      const second = await runStagingReaper(env);
      expect(second.cursor).toEqual(first.nextAfter);
      expect(second.deleted).toEqual([{ workspace: WS, key: oldKey, reason: "abandoned" }]);
      expect(bucket.store.has(oldKey)).toBe(false);
      // Short final page → cursor cleared so the next run restarts from the head.
      expect(second.nextAfter).toBeNull();
      expect(registry.store.has(STAGING_REAPER_CURSOR_KEY)).toBe(false);

      const third = await runStagingReaper(env);
      expect(third.cursor).toBeNull();
      expect(third.scanned).toBe(STAGING_REAP_SCAN_LIMIT);
      expect(third.deleted).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("treats a corrupt cursor in KV as start-of-set", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { env, bucket, registry } = makeEnv({ db: sqlite });
      const key = branchKey(WS, "feat-y", "shot.png");
      await seed(sqlite, bucket, WS, key, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(ABANDONED_MAX_AGE_DAYS + 1),
      });
      // Corrupt blob — not { workspace, key } strings.
      registry.store.set(STAGING_REAPER_CURSOR_KEY, { workspace: 1, key: null });

      const result = await runStagingReaper(env);

      expect(result.cursor).toBeNull();
      expect(result.deleted).toEqual([{ workspace: WS, key, reason: "abandoned" }]);
    } finally {
      sqlite.close();
    }
  });
});
