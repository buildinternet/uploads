import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getFileMetadata, replaceFileMetadata } from "../src/file-metadata";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

/**
 * Regression guard for #421: the staging reaper (#314) is retired, and no
 * replacement exists. Branch-staged objects are removable only via
 * per-workspace retention or explicit `files:delete` (docs/deletion.md).
 * This drives the real Worker `scheduled` handler end to end (not a direct
 * call into a sweep module) so a reintroduced cron task would be caught here
 * too, whatever it's named.
 */

const MIGRATIONS = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260824120000_idempotency_requests.sql",
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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function branchKey(workspace: string, branch: string, filename: string): string {
  return `gh/${workspace}/repo/branch/${branch}/${filename}`;
}

/** Fake REGISTRY: get/put/delete/list over an in-memory Map (workspace records only). */
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
    list: (async (opts: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })) as unknown as KVNamespace["list"],
  };
}

/**
 * `scheduled` fires its sweeps via `ctx.waitUntil` without awaiting them
 * itself, so the test needs its own collection point to know when every
 * cron task (retention sweep, observability retention, …) has settled.
 */
function fakeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(pending) };
}

describe("scheduled handler — no staging reaper (#421)", () => {
  it("never deletes branch-staged objects, promoted or abandoned, however old", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      const registry = fakeRegistry({ [`ws:${WS}`]: RECORD });
      const env = { REGISTRY: registry, BUCKET: bucket, DB: database(sqlite) } as unknown as Env;

      // Shaped exactly like the retired `promoted` rule's target: promoted
      // long past the old 7-day age cutoff.
      const promotedKey = branchKey(WS, "feat-x", "shot.png");
      await bucket.put(promotedKey, PNG, { httpMetadata: { contentType: "image/png" } });
      await replaceFileMetadata(database(sqlite), WS, promotedKey, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(400),
        "gh.promoted-to": "pull/12",
        "gh.promoted-at": daysAgo(300),
      });

      // Shaped exactly like the retired `abandoned` rule's target: never
      // promoted, staged long past the old 30-day cutoff.
      const abandonedKey = branchKey(WS, "feat-y", "shot.png");
      await bucket.put(abandonedKey, PNG, { httpMetadata: { contentType: "image/png" } });
      await replaceFileMetadata(database(sqlite), WS, abandonedKey, {
        "gh.kind": "branch",
        "gh.staged-at": daysAgo(400),
      });

      const insertIdempotency = sqlite.db.prepare(
        `INSERT INTO idempotency_requests
         (workspace, principal, operation, key_hash, fingerprint, owner_nonce, state,
          response_status, response_body, created_at, expires_at)
         VALUES (?, 'd1-token:test', 'gallery.create.v1', ?, 'fingerprint', NULL,
                 'completed', 201, '{}', ?, ?)`,
      );
      insertIdempotency.run(WS, "expired", daysAgo(2), daysAgo(1));
      insertIdempotency.run(
        WS,
        "current",
        new Date().toISOString(),
        new Date(Date.now() + MS_PER_DAY).toISOString(),
      );

      const { ctx, settle } = fakeExecutionContext();
      await worker.scheduled({} as ScheduledController, env, ctx);
      await settle();

      expect(bucket.store.has(promotedKey)).toBe(true);
      expect(bucket.store.has(abandonedKey)).toBe(true);
      expect(await getFileMetadata(database(sqlite), WS, promotedKey)).toMatchObject({
        "gh.kind": "branch",
      });
      expect(await getFileMetadata(database(sqlite), WS, abandonedKey)).toMatchObject({
        "gh.kind": "branch",
      });
      expect(
        sqlite.db.prepare("SELECT key_hash FROM idempotency_requests ORDER BY key_hash").all(),
      ).toEqual([{ key_hash: "current" }]);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * Regression guard for #929: the daily hosted-host SVG/XML sandboxing-CSP
 * sweep (`runActiveContentHostSweep`, apps/api/src/active-content-hosts.ts)
 * joins the same `scheduled` cron as retention/observability/idempotency/
 * usage-alert — driven end to end here for the same reason as the block
 * above (a removed or renamed cron task is caught even if this file never
 * imports the sweep module by name).
 */
describe("scheduled handler — active-content host sweep (#929)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes the daily hosted-host sandboxing-CSP probe and writes host records", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const bucket = new FakeR2Bucket();
      const uploadsDefault = new FakeR2Bucket();
      const registry = fakeRegistry({ [`ws:${WS}`]: RECORD });
      const env = {
        REGISTRY: registry,
        BUCKET: bucket,
        UPLOADS_DEFAULT: uploadsDefault,
        DB: database(sqlite),
      } as unknown as Env;

      const fetchSpy = vi.fn(
        async () =>
          new Response("<svg/>", {
            status: 200,
            headers: {
              "content-type": "image/svg+xml",
              "content-security-policy": "default-src 'none'; sandbox",
              "x-content-type-options": "nosniff",
            },
          }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const { ctx, settle } = fakeExecutionContext();
      await worker.scheduled({} as ScheduledController, env, ctx);
      await settle();

      expect(fetchSpy).toHaveBeenCalled();
      expect(registry.store.get("host-active-content:storage.uploads.sh")).toMatchObject({
        ok: true,
      });
      expect(registry.store.get("host-active-content:store.uploads.sh")).toMatchObject({
        ok: true,
      });
      expect(registry.store.get("host-active-content:embed.uploads.sh")).toMatchObject({
        ok: true,
      });
      // The probe object is never left behind in the shared bucket.
      expect(uploadsDefault.store.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
