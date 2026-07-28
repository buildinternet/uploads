/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import {
  activeWorkspacesSince,
  featureTotals,
  platformSeries,
  platformStorage,
  windowStart,
  workspaceActivity,
} from "../src/adoption-queries";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";
const USAGE_MIGRATION = "migrations/20260710140000_workspace_usage.sql";

async function seed(db: D1Database): Promise<void> {
  const day = (d: string) => new Date(`${d}T10:00:00Z`);
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, day("2026-07-26"));
  await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 200 }, day("2026-07-28"));
  await bumpDailyMetric(db, { metric: "upload", workspace: "beta", bytes: 50 }, day("2026-07-28"));
  await bumpDailyMetric(db, { metric: "gallery_created", workspace: "acme" }, day("2026-07-28"));
}

describe("windowStart", () => {
  it("returns the inclusive first day of an N-day window", () => {
    expect(windowStart(7, new Date("2026-07-28T00:00:00Z"))).toBe("2026-07-22");
  });

  it("treats a 1-day window as today only", () => {
    expect(windowStart(1, new Date("2026-07-28T00:00:00Z"))).toBe("2026-07-28");
  });
});

describe("platformSeries", () => {
  it("reads only platform rows, one point per day with activity", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await platformSeries(db, "upload", "2026-07-01")).toEqual([
        { day: "2026-07-26", count: 1, bytes: 100 },
        { day: "2026-07-28", count: 2, bytes: 250 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("excludes days before the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await platformSeries(db, "upload", "2026-07-27")).toEqual([
        { day: "2026-07-28", count: 2, bytes: 250 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("workspaceActivity", () => {
  it("aggregates per workspace and sorts by uploads descending", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await workspaceActivity(db, "2026-07-01")).toEqual([
        { workspace: "acme", uploads: 2, bytes: 300, lastActive: "2026-07-28" },
        { workspace: "beta", uploads: 1, bytes: 50, lastActive: "2026-07-28" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("never includes the platform sentinel row", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await workspaceActivity(db, "2026-07-01");
      expect(rows.some((row) => row.workspace === "")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe("activeWorkspacesSince", () => {
  it("returns one row per workspace that uploaded in the window, with lastActive", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await activeWorkspacesSince(db, "2026-07-01");
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.workspace).sort()).toEqual(["acme", "beta"]);
      expect(rows.find((r) => r.workspace === "acme")?.lastActive).toBe("2026-07-28");
      expect(rows.find((r) => r.workspace === "beta")?.lastActive).toBe("2026-07-28");
    } finally {
      sqlite.close();
    }
  });

  it("excludes days before the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await activeWorkspacesSince(db, "2026-07-29")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("does not include a workspace whose only activity was a gallery", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "gallery_created", workspace: "gamma" },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await activeWorkspacesSince(db, "2026-07-01")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  // Fix 5: metrics-overview.ts derives BOTH the 7d and 30d active-workspace
  // counts from a single 30-day activeWorkspacesSince call (rather than two
  // separate queries), by filtering these rows on `lastActive`. Prove that
  // derivation is correct for a workspace active in the 30d window but NOT
  // the 7d window — the case a naive "just count the 30d rows" approach for
  // both figures would get wrong.
  it("supports deriving both a 7d and 30d count from one 30-day call", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      // Only active on 2026-07-05: inside a 30-day window starting
      // 2026-06-29, but well before a 7-day window starting 2026-07-22.
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "delta" },
        new Date("2026-07-05T10:00:00Z"),
      );
      await seed(db); // acme/beta, both last active 2026-07-28

      const since30 = "2026-06-29";
      const since7 = "2026-07-22";
      const rows = await activeWorkspacesSince(db, since30);

      expect(rows.map((r) => r.workspace).sort()).toEqual(["acme", "beta", "delta"]);

      const active30d = rows.length;
      const active7d = rows.filter((r) => r.lastActive >= since7).length;
      expect(active30d).toBe(3);
      // delta is in the 30d count but drops out of the 7d count.
      expect(active7d).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});

describe("featureTotals", () => {
  it("returns a per-metric total from platform rows", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await featureTotals(db, "2026-07-01")).toEqual({ upload: 3, gallery_created: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("excludes days before the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      // seed() writes an "upload" row on 2026-07-26 (count 1) and more on
      // 2026-07-28 (count 2); a `since` after the earlier day must drop only
      // that earlier count, not the metric entirely.
      expect(await featureTotals(db, "2026-07-27")).toEqual({ upload: 2, gallery_created: 1 });
    } finally {
      sqlite.close();
    }
  });
});

describe("platformStorage", () => {
  it("reports current workspace count and stored bytes from workspace_usage", async () => {
    const sqlite = new SqliteD1([USAGE_MIGRATION, MIGRATION]);
    try {
      const db = database(sqlite);
      await db
        .prepare(
          `INSERT INTO workspace_usage (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
           VALUES ('acme', 500, 2, 2, '2026-07', '2026-07-28T00:00:00Z'),
                  ('beta', 250, 1, 1, '2026-07', '2026-07-28T00:00:00Z')`,
        )
        .run();
      expect(await platformStorage(db)).toEqual({ workspaces: 2, storedBytes: 750 });
    } finally {
      sqlite.close();
    }
  });

  it("returns zeros on an empty ledger rather than nulls", async () => {
    const sqlite = new SqliteD1([USAGE_MIGRATION, MIGRATION]);
    try {
      expect(await platformStorage(database(sqlite))).toEqual({ workspaces: 0, storedBytes: 0 });
    } finally {
      sqlite.close();
    }
  });
});
