/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";

describe("feature adoption metric vocabulary", () => {
  it("records each feature metric under its own key with zero bytes", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      for (const metric of [
        "workspace_created",
        "gallery_created",
        "comment_posted",
        "repo_linked",
      ] as const) {
        await bumpDailyMetric(db, { metric, workspace: "acme" }, at);
      }
      const result = await db
        .prepare(
          `SELECT metric, count, bytes FROM daily_metrics
           WHERE workspace = 'acme' ORDER BY metric`,
        )
        .all<{ metric: string; count: number; bytes: number }>();
      expect(result.results).toEqual([
        { metric: "comment_posted", count: 1, bytes: 0 },
        { metric: "gallery_created", count: 1, bytes: 0 },
        { metric: "repo_linked", count: 1, bytes: 0 },
        { metric: "workspace_created", count: 1, bytes: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps feature metrics out of the upload series", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "gallery_created", workspace: "acme" },
        new Date("2026-07-28T10:00:00Z"),
      );
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM daily_metrics WHERE metric = 'upload'`)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
