/**
 * Coverage for SqliteD1's row-returning-statement heuristic in runSync()
 * (issue caught in CodeRabbit review of PR #544): a batched statement that
 * returns rows but doesn't literally start with `SELECT` — a `WITH ...
 * SELECT` CTE, or one with a leading `--` comment — used to be routed to
 * `.run()`, which executes the statement but silently discards its rows.
 */

import { describe, expect, it } from "vitest";
import { SqliteD1, database } from "./sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
];

describe("SqliteD1 row-returning-statement detection", () => {
  it("returns rows for a WITH ... SELECT CTE run through db.batch()", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await db
        .prepare(
          `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
           VALUES ('acme', 100, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
        )
        .run();

      const [result] = await db.batch([
        db.prepare(
          `WITH totals AS (SELECT workspace, bytes FROM workspace_usage)
           SELECT workspace, bytes FROM totals WHERE workspace = 'acme'`,
        ),
      ]);
      expect(result.results).toEqual([{ workspace: "acme", bytes: 100 }]);
    } finally {
      sqlite.close();
    }
  });

  it("still returns rows for a SELECT preceded by a leading -- comment", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const [result] = await db.batch([db.prepare(`-- explain why\nSELECT 1 AS one`)]);
      expect(result.results).toEqual([{ one: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  it("still routes a plain mutation through .run() and reports changes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const [result] = await db.batch([
        db.prepare(
          `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
           VALUES ('beta', 50, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
        ),
      ]);
      expect(result.results).toEqual([]);
      expect(result.meta.changes).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
