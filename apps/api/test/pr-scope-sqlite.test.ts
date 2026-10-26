/// <reference types="node" />

import type { SQLInputValue } from "node:sqlite";
import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import { FILE_TYPE_CLASSES, fileTypeClassFromKey } from "@uploads/comment-render/scope";
import { findObjectsByMetadata, replaceFileMetadata, setFileMetadata } from "../src/file-metadata";
import {
  decodeScopeCursor,
  encodeScopeCursor,
  listWorkspaceRepos,
  prScopeQuery,
  scanScopeKeys,
  type ScopeItem,
} from "../src/pr-scope";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20261004120200_file_metadata_gh_repo_idx.sql",
];

async function seed(
  sqlite: SqliteD1,
  key: string,
  meta: Record<string, string>,
  updatedAt: string,
  workspace = "alpha",
) {
  await replaceFileMetadata(database(sqlite), workspace, key, meta);
  sqlite.db
    .prepare(`UPDATE file_metadata SET updated_at = ? WHERE workspace = ? AND object_key = ?`)
    .run(updatedAt, workspace, key);
}

/** Wraps the fake so a test can read back the SQL and binds a call issued. */
function recordingDb(sqlite: SqliteD1) {
  const seen: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        seen.push({ sql, values });
        return bind(...values);
      };
      return statement;
    },
    batch: sqlite.batch.bind(sqlite),
  };
  return { db: db as unknown as D1Database, seen };
}

function queryPlan(sqlite: SqliteD1, entry: { sql: string; values: unknown[] }): string {
  const rows = sqlite.db
    .prepare(`EXPLAIN QUERY PLAN ${entry.sql}`)
    .all(...(entry.values as SQLInputValue[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join("\n");
}

const keysOf = (items: ScopeItem[]) => items.map((item) => item.key);

describe("prScopeQuery", () => {
  it("matches gh.repo and gh.number, drops promoted shadows, and does not require path", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seed(
        sqlite,
        "gh/acme/app/pull/1/a.png",
        { "gh.repo": "acme/app", "gh.number": "1", path: "/x" },
        "2026-10-01T01:00:00.000Z",
      );
      await seed(
        sqlite,
        "gh/acme/app/pull/1/b.mp4",
        { "gh.repo": "acme/app", "gh.number": "1" },
        "2026-10-01T02:00:00.000Z",
      );
      await seed(
        sqlite,
        "gh/acme/app/pull/2/c.png",
        { "gh.repo": "acme/app", "gh.number": "2" },
        "2026-10-01T03:00:00.000Z",
      );
      await seed(
        sqlite,
        "gh/acme/app/branch/f/d.png",
        { "gh.repo": "acme/app", "gh.number": "1", "gh.status": "promoted" },
        "2026-10-01T04:00:00.000Z",
      );
      await seed(
        sqlite,
        "gh/acme/web/pull/1/e.png",
        { "gh.repo": "acme/web", "gh.number": "1" },
        "2026-10-01T05:00:00.000Z",
      );
      await seed(
        sqlite,
        "gh/acme/app/pull/1/f.png",
        { "gh.repo": "acme/app", "gh.number": "1" },
        "2026-10-01T06:00:00.000Z",
        "beta",
      );
      const db = database(sqlite);

      const repo = await prScopeQuery(db, { workspace: "alpha", repo: "acme/app" });
      expect(keysOf(repo.items)).toEqual([
        "gh/acme/app/pull/2/c.png",
        "gh/acme/app/pull/1/b.mp4",
        "gh/acme/app/pull/1/a.png",
      ]);
      expect(repo.nextCursor).toBeNull();
      expect(repo.items[2]?.metadata).toMatchObject({ "gh.number": "1", path: "/x" });

      const pr = await prScopeQuery(db, { workspace: "alpha", repo: "acme/app", number: 1 });
      expect(keysOf(pr.items)).toEqual(["gh/acme/app/pull/1/b.mp4", "gh/acme/app/pull/1/a.png"]);

      const byPath = await prScopeQuery(db, { workspace: "alpha", repo: "acme/app", path: "/x" });
      expect(keysOf(byPath.items)).toEqual(["gh/acme/app/pull/1/a.png"]);
    } finally {
      sqlite.close();
    }
  });

  it("pages newest first and breaks updated_at ties by key without repeats or gaps", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const tie = "2026-10-01T00:00:00.000Z";
      for (const name of ["k1", "k2", "k3", "k4", "k5"]) {
        await seed(sqlite, `s/${name}.png`, { "gh.repo": "acme/app" }, tie);
      }
      await seed(sqlite, "s/newest.png", { "gh.repo": "acme/app" }, "2026-10-02T00:00:00.000Z");
      const db = database(sqlite);

      const seen: string[] = [];
      let cursor = null as Awaited<ReturnType<typeof prScopeQuery>>["nextCursor"];
      const pages: string[][] = [];
      do {
        const page = await prScopeQuery(db, {
          workspace: "alpha",
          repo: "acme/app",
          cursor,
          limit: 2,
        });
        pages.push(keysOf(page.items));
        seen.push(...keysOf(page.items));
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toEqual([
        ["s/newest.png", "s/k1.png"],
        ["s/k2.png", "s/k3.png"],
        ["s/k4.png", "s/k5.png"],
      ]);
      expect(new Set(seen).size).toBe(6);
    } finally {
      sqlite.close();
    }
  });

  it("filters by key suffix exactly as fileTypeClassFromKey classifies", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const keys = [
        "s/one.png",
        "s/TWO.JPEG",
        "s/three.webp",
        "s/four.gif",
        "s/five.avif",
        "s/six.jpg",
        "v/a.mp4",
        "v/b.WEBM",
        "v/c.mov",
        "o/d.pdf",
        "o/notes",
        "o/e.png.zip",
        "o/f.txt",
        "gh/private/0123456789abcdef0123456789abcdef/pull/12/a-long-file-name.png",
      ];
      for (const [i, key] of keys.entries()) {
        await seed(
          sqlite,
          key,
          { "gh.repo": "acme/app" },
          `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        );
      }
      const db = database(sqlite);
      for (const type of FILE_TYPE_CLASSES) {
        const page = await prScopeQuery(db, {
          workspace: "alpha",
          repo: "acme/app",
          type,
          limit: 100,
        });
        expect(keysOf(page.items).sort()).toEqual(
          keys.filter((key) => fileTypeClassFromKey(key) === type).sort(),
        );
      }
    } finally {
      sqlite.close();
    }
  });

  it("reads the partial gh.repo index in order, with no temp sort", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const { db, seen } = recordingDb(sqlite);
      await prScopeQuery(db, {
        workspace: "alpha",
        repo: "acme/app",
        number: 3,
        type: "screenshot",
        cursor: { updatedAt: "2026-10-01T00:00:00.000Z", key: "a" },
      });
      const scope = seen.find((entry) => entry.sql.includes("r.meta_key = 'gh.repo'"));
      expect(scope).toBeDefined();
      const plan = queryPlan(sqlite, scope!);
      expect(plan).toContain("COVERING INDEX file_metadata_gh_repo_recent_idx");
      expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");

      await listWorkspaceRepos(db, "alpha", { limit: 20 });
      const repos = seen.find((entry) => entry.sql.includes("GROUP BY r.meta_value"));
      expect(queryPlan(sqlite, repos!)).toContain(
        "COVERING INDEX file_metadata_gh_repo_recent_idx",
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("scanScopeKeys", () => {
  it("returns scope keys newest first up to the cap, without metadata", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      for (let i = 0; i < 7; i++) {
        await seed(
          sqlite,
          `s/${i}.png`,
          { "gh.repo": "acme/app", "gh.number": "4" },
          `2026-10-01T00:00:0${i}.000Z`,
        );
      }
      const db = database(sqlite);
      const all = await scanScopeKeys(db, { workspace: "alpha", repo: "acme/app", number: 4 });
      expect(keysOf(all)).toEqual([
        "s/6.png",
        "s/5.png",
        "s/4.png",
        "s/3.png",
        "s/2.png",
        "s/1.png",
        "s/0.png",
      ]);
      expect(all[0]?.metadata).toEqual({});
      expect(all[0]?.updatedAt).toBe("2026-10-01T00:00:06.000Z");
      const capped = await scanScopeKeys(db, { workspace: "alpha", repo: "acme/app" }, { cap: 5 });
      expect(capped).toHaveLength(5);
    } finally {
      sqlite.close();
    }
  });
});

describe("listWorkspaceRepos", () => {
  it("lists distinct repos newest first with a keyset cursor, per workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await seed(sqlite, "a/1.png", { "gh.repo": "acme/app" }, "2026-10-01T01:00:00.000Z");
      await seed(sqlite, "a/2.png", { "gh.repo": "acme/app" }, "2026-10-01T05:00:00.000Z");
      await seed(sqlite, "s/1.png", { "gh.repo": "acme/site" }, "2026-10-01T03:00:00.000Z");
      await seed(sqlite, "d/1.png", { "gh.repo": "acme/docs" }, "2026-10-01T03:00:00.000Z");
      await seed(sqlite, "x/1.png", { "gh.repo": "beta/only" }, "2026-10-01T09:00:00.000Z", "beta");
      const db = database(sqlite);

      const first = await listWorkspaceRepos(db, "alpha", { limit: 2 });
      expect(first.repos).toEqual([
        { repo: "acme/app", lastUpdatedAt: "2026-10-01T05:00:00.000Z" },
        { repo: "acme/docs", lastUpdatedAt: "2026-10-01T03:00:00.000Z" },
      ]);
      expect(first.nextCursor).toEqual({ updatedAt: "2026-10-01T03:00:00.000Z", key: "acme/docs" });
      const second = await listWorkspaceRepos(db, "alpha", { limit: 2, cursor: first.nextCursor });
      expect(second.repos).toEqual([
        { repo: "acme/site", lastUpdatedAt: "2026-10-01T03:00:00.000Z" },
      ]);
      expect(second.nextCursor).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("skips promoted shadows, so they neither list a repo nor set lastUpdatedAt", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const shadow = { "gh.status": "promoted" };
      await seed(sqlite, "a/1.png", { "gh.repo": "acme/app" }, "2026-10-01T01:00:00.000Z");
      await seed(
        sqlite,
        "a/shadow.png",
        { "gh.repo": "acme/app", ...shadow },
        "2026-10-01T08:00:00.000Z",
      );
      await seed(
        sqlite,
        "o/shadow.png",
        { "gh.repo": "acme/only-shadows", ...shadow },
        "2026-10-01T09:00:00.000Z",
      );
      const page = await listWorkspaceRepos(database(sqlite), "alpha", { limit: 20 });
      expect(page.repos).toEqual([{ repo: "acme/app", lastUpdatedAt: "2026-10-01T01:00:00.000Z" }]);
    } finally {
      sqlite.close();
    }
  });
});

describe("gh.repo canonical spelling", () => {
  it("stores gh.repo lowercased, so a hand-set mixed-case repo stays in scope and in search", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await replaceFileMetadata(db, "alpha", "s/hand.png", {
        "gh.repo": "Acme/App",
        path: "/Mixed",
      });
      await setFileMetadata(db, "alpha", "s/set.png", { "gh.repo": "ACME/app" });

      const page = await prScopeQuery(db, { workspace: "alpha", repo: "acme/app" });
      expect(keysOf(page.items).sort()).toEqual(["s/hand.png", "s/set.png"]);
      // Only gh.repo is canonicalized; other values keep their case.
      expect(page.items.find((item) => item.key === "s/hand.png")?.metadata).toMatchObject({
        "gh.repo": "acme/app",
        path: "/Mixed",
      });

      const found = await findObjectsByMetadata(db, "alpha", { "gh.repo": "Acme/App" });
      expect(found.map((row) => row.key).sort()).toEqual(["s/hand.png", "s/set.png"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("scope cursor codec", () => {
  function expectRejected(raw: string): void {
    try {
      decodeScopeCursor(raw);
    } catch (err) {
      expect((err as AppError).code).toBe("invalid_cursor");
      expect((err as AppError).status).toBe(400);
      return;
    }
    throw new Error(`expected ${raw} to be rejected`);
  }

  it("round-trips a non-ASCII key, is URL-safe, and treats empty as no cursor", () => {
    const cursor = { updatedAt: "2026-10-01T00:00:00.000Z", key: "shots/café-née.png" };
    const raw = encodeScopeCursor(cursor);
    expect(encodeURIComponent(raw)).toBe(raw);
    expect(raw).not.toContain("shots/");
    expect(decodeScopeCursor(raw)).toEqual(cursor);
    expect(decodeScopeCursor(undefined)).toBeNull();
    expect(decodeScopeCursor("")).toBeNull();
  });

  it("rejects garbage, other versions, bad dates, and empty keys with one code", () => {
    expectRejected("not-a-cursor");
    expectRejected(btoa(JSON.stringify({ hello: "world" })));
    expectRejected(btoa(JSON.stringify({ v: 2, u: "2026-10-01T00:00:00.000Z", k: "a" })));
    expectRejected(btoa(JSON.stringify({ v: 1, u: "yesterday", k: "a" })));
    expectRejected(btoa(JSON.stringify({ v: 1, u: "2026-10-01T00:00:00.000Z", k: "" })));
  });
});
