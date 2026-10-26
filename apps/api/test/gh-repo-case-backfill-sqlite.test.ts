/// <reference types="node" />

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { backfillLowercasedMetaValues } from "../src/gh-repo-case-backfill";
import { respondError } from "../src/error-response";
import { admin } from "../src/routes/admin";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260713210559_file_metadata.sql"];
const ADMIN_TOKEN = "test-admin-token";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function put(sqlite: SqliteD1, workspace: string, key: string, metaKey: string, value: string) {
  sqlite.db
    .prepare(
      `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
       VALUES (?, ?, ?, ?, '2026-09-01T00:00:00.000Z')`,
    )
    .run(workspace, key, metaKey, value);
}

function value(sqlite: SqliteD1, workspace: string, key: string, metaKey: string) {
  return sqlite.db
    .prepare(
      `SELECT meta_value AS v, updated_at AS u FROM file_metadata
         WHERE workspace = ? AND object_key = ? AND meta_key = ?`,
    )
    .get(workspace, key, metaKey) as { v: string; u: string } | undefined;
}

function seed(sqlite: SqliteD1) {
  put(sqlite, "alpha", "a.png", "gh.repo", "Acme/Web");
  put(sqlite, "alpha", "b.png", "gh.repo", "acme/web"); // already canonical
  put(sqlite, "beta", "a.png", "gh.repo", "ACME/API"); // another workspace, same key name
  put(sqlite, "alpha", "a.png", "gh.number", "12");
  put(sqlite, "alpha", "a.png", "path", "/Settings/Billing"); // other keys keep their case
  put(sqlite, "alpha", "a.png", "gh.ref", "Acme/Web#12"); // not canonicalized by Task 2
}

describe("backfillLowercasedMetaValues", () => {
  it("dry-run reports the affected row count and writes nothing", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      seed(sqlite);
      const result = await backfillLowercasedMetaValues(database(sqlite), { dryRun: true });
      expect(result).toEqual({ dryRun: true, affected: 2, updated: 0, batches: 0, remaining: 2 });
      expect(value(sqlite, "alpha", "a.png", "gh.repo")?.v).toBe("Acme/Web");
    } finally {
      sqlite.close();
    }
  });

  it("lowercases only gh.repo, keeps updated_at, and is idempotent", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      seed(sqlite);
      const result = await backfillLowercasedMetaValues(database(sqlite));
      expect(result).toMatchObject({ dryRun: false, affected: 2, updated: 2, remaining: 0 });
      expect(value(sqlite, "alpha", "a.png", "gh.repo")).toEqual({
        v: "acme/web",
        u: "2026-09-01T00:00:00.000Z",
      });
      expect(value(sqlite, "beta", "a.png", "gh.repo")?.v).toBe("acme/api");
      expect(value(sqlite, "alpha", "a.png", "path")?.v).toBe("/Settings/Billing");
      expect(value(sqlite, "alpha", "a.png", "gh.ref")?.v).toBe("Acme/Web#12");
      expect(value(sqlite, "alpha", "a.png", "gh.number")?.v).toBe("12");

      expect(await backfillLowercasedMetaValues(database(sqlite))).toEqual({
        dryRun: false,
        affected: 0,
        updated: 0,
        batches: 0,
        remaining: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("works in bounded batches and reports what remains", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      for (let i = 0; i < 7; i++) put(sqlite, "alpha", `k${i}.png`, "gh.repo", "Acme/Web");
      const first = await backfillLowercasedMetaValues(database(sqlite), {
        batchSize: 3,
        maxBatches: 2,
      });
      expect(first).toMatchObject({ affected: 7, updated: 6, batches: 2, remaining: 1 });
      const second = await backfillLowercasedMetaValues(database(sqlite), {
        batchSize: 3,
        maxBatches: 2,
      });
      expect(second).toMatchObject({ affected: 1, updated: 1, remaining: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("repairs the scope: a backfilled object now matches the lowercase scope query", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      put(sqlite, "alpha", "a.png", "gh.repo", "Acme/Web");
      const scoped = () =>
        sqlite.db
          .prepare(
            `SELECT object_key FROM file_metadata
             WHERE workspace = 'alpha' AND meta_key = 'gh.repo' AND meta_value = 'acme/web'`,
          )
          .all();
      expect(scoped()).toHaveLength(0);
      await backfillLowercasedMetaValues(database(sqlite));
      expect(scoped()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("POST /admin/file-metadata/backfill-gh-repo-case", () => {
  function appFor(sqlite: SqliteD1) {
    const app = new Hono<{ Bindings: Env }>()
      .route("/admin", admin)
      .onError((err, c) => respondError(c, err));
    const env = { ADMIN_TOKEN, DB: sqlite } as unknown as Env;
    const call = (query = "", token = ADMIN_TOKEN) =>
      app.request(
        `https://api.uploads.sh/admin/file-metadata/backfill-gh-repo-case${query}`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
        env,
      );
    return call;
  }

  it("requires the admin token, honors ?dryRun=1, and applies otherwise", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      seed(sqlite);
      const call = appFor(sqlite);
      expect((await call("", "wrong")).status).toBe(401);

      const dry = await call("?dryRun=1");
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ dryRun: true, affected: 2, updated: 0 });
      expect(value(sqlite, "alpha", "a.png", "gh.repo")?.v).toBe("Acme/Web");

      const live = await call();
      expect(await live.json()).toMatchObject({ dryRun: false, updated: 2, remaining: 0 });
      expect(value(sqlite, "alpha", "a.png", "gh.repo")?.v).toBe("acme/web");
    } finally {
      sqlite.close();
    }
  });
});
