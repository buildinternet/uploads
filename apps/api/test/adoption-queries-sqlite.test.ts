/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import {
  countActiveWorkspaces,
  deriveUploadSummary,
  deriveWorkspaceActivity,
  featureTotals,
  platformSeries,
  platformStorage,
  rowsSince,
  uploadsOnDay,
  windowStart,
  workspaceDaySeries,
  workspaceUploadSeries,
  workspacesWithGithubApp,
} from "../src/adoption-queries";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";
const USAGE_MIGRATION = "migrations/20260710140000_workspace_usage.sql";
const SHARED_USAGE_MIGRATION = "migrations/20260822120100_workspace_usage_shared_subset.sql";
const REPO_LINKS_MIGRATION = "migrations/20260720120000_github_repo_links.sql";

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

/** Read the single per-workspace scan and derive the activity table from it. */
async function activity(db: D1Database, since: string, limit?: number) {
  const rows = await workspaceDaySeries(db, since);
  return deriveWorkspaceActivity(rows, since, await workspacesWithGithubApp(db), limit);
}

describe("workspaceDaySeries", () => {
  it("returns one row per (day, workspace), busiest first within a day", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await workspaceDaySeries(db, "2026-07-01")).toEqual([
        { day: "2026-07-26", workspace: "acme", count: 1, bytes: 100 },
        { day: "2026-07-28", workspace: "acme", count: 1, bytes: 200 },
        { day: "2026-07-28", workspace: "beta", count: 1, bytes: 50 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("uploadsOnDay", () => {
  it("returns every contributor for exactly that day, busiest first", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "beta", bytes: 5 },
        new Date("2026-07-28T11:00:00Z"),
      );
      expect(await uploadsOnDay(db, "2026-07-28")).toEqual([
        { day: "2026-07-28", workspace: "beta", count: 2, bytes: 55 },
        { day: "2026-07-28", workspace: "acme", count: 1, bytes: 200 },
      ]);
      expect(await uploadsOnDay(db, "2026-07-27")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("workspaceUploadSeries", () => {
  it("returns one workspace's daily upload rows within the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await workspaceUploadSeries(db, "acme", "2026-07-01")).toEqual([
        { day: "2026-07-26", count: 1, bytes: 100 },
        { day: "2026-07-28", count: 1, bytes: 200 },
      ]);
      expect(await workspaceUploadSeries(db, "acme", "2026-07-27")).toEqual([
        { day: "2026-07-28", count: 1, bytes: 200 },
      ]);
      expect(await workspaceUploadSeries(db, "nobody", "2026-07-01")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("deriveUploadSummary", () => {
  const rows = [
    { day: "2026-07-26", workspace: "acme", count: 1, bytes: 1 },
    { day: "2026-07-28", workspace: "a", count: 5, bytes: 1 },
    { day: "2026-07-28", workspace: "b", count: 3, bytes: 1 },
    { day: "2026-07-28", workspace: "c", count: 3, bytes: 1 },
    { day: "2026-07-28", workspace: "d", count: 1, bytes: 1 },
  ];

  it("keeps the top contributors per day with totals and distinct counts", () => {
    const { byDay } = deriveUploadSummary(rows);
    expect(byDay[0]).toEqual({
      day: "2026-07-26",
      total: 1,
      workspaces: 1,
      top: [{ workspace: "acme", count: 1 }],
    });
    expect(byDay[1].total).toBe(12);
    expect(byDay[1].workspaces).toBe(4);
    expect(byDay[1].top.map((t) => t.workspace)).toEqual(["a", "b", "c"]);
  });

  it("caps and orders the workspace list by window volume", () => {
    expect(deriveUploadSummary(rows, 3, 2).workspaces).toEqual([
      { workspace: "a", count: 5 },
      { workspace: "b", count: 3 },
    ]);
  });
});

describe("deriveWorkspaceActivity", () => {
  it("aggregates per workspace and sorts by uploads descending", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await seed(db);
      expect(await activity(db, "2026-07-01")).toEqual([
        { workspace: "acme", uploads: 2, bytes: 300, lastActive: "2026-07-28", githubApp: false },
        { workspace: "beta", uploads: 1, bytes: 50, lastActive: "2026-07-28", githubApp: false },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("never includes the platform sentinel row", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await activity(db, "2026-07-01");
      expect(rows.some((row) => row.workspace === "")).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("breaks ties by workspace name and applies the limit", () => {
    const rows = [
      { day: "2026-07-28", workspace: "zed", count: 2, bytes: 1 },
      { day: "2026-07-28", workspace: "bob", count: 2, bytes: 1 },
      { day: "2026-07-28", workspace: "amy", count: 1, bytes: 1 },
    ];
    expect(deriveWorkspaceActivity(rows, "2026-07-01", new Set()).map((r) => r.workspace)).toEqual([
      "bob",
      "zed",
      "amy",
    ]);
    expect(deriveWorkspaceActivity(rows, "2026-07-01", new Set(), 2)).toHaveLength(2);
  });

  it("totals only days inside the window, from a wider scan", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await seed(db);
      const wide = await workspaceDaySeries(db, "2026-07-01");
      expect(deriveWorkspaceActivity(wide, "2026-07-27", new Set())).toEqual([
        { workspace: "acme", uploads: 1, bytes: 200, lastActive: "2026-07-28", githubApp: false },
        { workspace: "beta", uploads: 1, bytes: 50, lastActive: "2026-07-28", githubApp: false },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("sets githubApp true only for a workspace with a linked, installed repo", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await seed(db);
      await db
        .prepare(
          `INSERT INTO github_repo_links (repo_full_name, workspace_name, installation_id, source, created_at)
           VALUES ('acme/repo', 'acme', 42, 'comment', '2026-07-28T00:00:00Z')`,
        )
        .run();
      const rows = await activity(db, "2026-07-01");
      expect(rows.find((r) => r.workspace === "acme")?.githubApp).toBe(true);
      expect(rows.find((r) => r.workspace === "beta")?.githubApp).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("does not count a repo link with a null installation_id as the GitHub App", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await seed(db);
      await db
        .prepare(
          `INSERT INTO github_repo_links (repo_full_name, workspace_name, installation_id, source, created_at)
           VALUES ('acme/repo', 'acme', NULL, 'comment', '2026-07-28T00:00:00Z')`,
        )
        .run();
      const rows = await activity(db, "2026-07-01");
      expect(rows.find((r) => r.workspace === "acme")?.githubApp).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe("rowsSince", () => {
  it("keeps only rows on or after the day, preserving order", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await workspaceDaySeries(db, "2026-07-01");
      expect(rowsSince(rows, "2026-07-27").map((r) => r.workspace)).toEqual(["acme", "beta"]);
      expect(rowsSince(rows, "2026-07-29")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("workspacesWithGithubApp", () => {
  it("returns the set of workspace names with a non-null installation_id link", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      const db = database(sqlite);
      await db
        .prepare(
          `INSERT INTO github_repo_links (repo_full_name, workspace_name, installation_id, source, created_at)
           VALUES ('acme/one', 'acme', 1, 'comment', '2026-07-28T00:00:00Z'),
                  ('acme/two', 'acme', 2, 'comment', '2026-07-28T00:00:00Z'),
                  ('beta/one', 'beta', NULL, 'comment', '2026-07-28T00:00:00Z')`,
        )
        .run();
      const result = await workspacesWithGithubApp(db);
      expect(result).toEqual(new Set(["acme"]));
    } finally {
      sqlite.close();
    }
  });

  it("returns an empty set when no links exist", async () => {
    const sqlite = new SqliteD1([MIGRATION, REPO_LINKS_MIGRATION]);
    try {
      expect(await workspacesWithGithubApp(database(sqlite))).toEqual(new Set());
    } finally {
      sqlite.close();
    }
  });
});

describe("countActiveWorkspaces", () => {
  it("counts distinct workspaces that uploaded in the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await workspaceDaySeries(db, "2026-07-01");
      // acme has two days of rows but is one workspace.
      expect(countActiveWorkspaces(rows, "2026-07-01")).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("excludes days before the window", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await seed(db);
      const rows = await workspaceDaySeries(db, "2026-07-01");
      expect(countActiveWorkspaces(rows, "2026-07-29")).toBe(0);
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
      const rows = await workspaceDaySeries(db, "2026-07-01");
      expect(countActiveWorkspaces(rows, "2026-07-01")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  // metrics-overview.ts derives BOTH the 7d and 30d counts (and the selected
  // window's table) from one scan over the widest window. A workspace active
  // in the 30d window but not the 7d window must drop out of the 7d count.
  it("derives both a 7d and 30d count from one 30-day scan", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "delta" },
        new Date("2026-07-05T10:00:00Z"),
      );
      await seed(db); // acme/beta, both last active 2026-07-28

      const rows = await workspaceDaySeries(db, "2026-06-29");
      expect(countActiveWorkspaces(rows, "2026-06-29")).toBe(3);
      expect(countActiveWorkspaces(rows, "2026-07-22")).toBe(2);
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
    const sqlite = new SqliteD1([USAGE_MIGRATION, SHARED_USAGE_MIGRATION, MIGRATION]);
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
    const sqlite = new SqliteD1([USAGE_MIGRATION, SHARED_USAGE_MIGRATION, MIGRATION]);
    try {
      expect(await platformStorage(database(sqlite))).toEqual({ workspaces: 0, storedBytes: 0 });
    } finally {
      sqlite.close();
    }
  });
});
