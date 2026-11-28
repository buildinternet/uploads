/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric } from "../src/adoption";
import { recordPrMediaActivity } from "../src/github-pr-activity";
import {
  ACTIVITY_SPAN_DAYS,
  buildWorkspaceActivity,
  withUploadTypes,
} from "../src/workspace-activity";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260728120000_daily_metrics.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
];

const at = (d: string) => new Date(`${d}T10:00:00Z`);
const NOW = at("2026-11-27");
const pr = (n: number, workspaceName: string) => ({
  repo: "acme/app",
  prNumber: n,
  workspaceName,
  count: 1,
});

describe("buildWorkspaceActivity", () => {
  it("fills one point per day and counts only this workspace", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme" }, at("2026-11-26"));
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme" }, at("2026-11-26"));
      await bumpDailyMetric(db, { metric: "upload", workspace: "beta" }, at("2026-11-26"));
      await bumpDailyMetric(db, { metric: "comment_posted", workspace: "acme" }, at("2026-11-27"));
      await bumpDailyMetric(db, { metric: "gallery_created", workspace: "acme" }, at("2026-11-27"));
      // Older than the span: ignored.
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme" }, at("2026-01-01"));

      const { days } = await buildWorkspaceActivity(db, "acme", NOW);
      expect(days).toHaveLength(ACTIVITY_SPAN_DAYS);
      expect(days.at(-1)).toEqual({ day: "2026-11-27", uploads: 0, prs: 0, comments: 1 });
      expect(days.at(-2)).toEqual({ day: "2026-11-26", uploads: 2, prs: 0, comments: 0 });
      expect(days.reduce((n, d) => n + d.uploads, 0)).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("counts a PR on the day of its first upload", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await recordPrMediaActivity(db, pr(1, "acme"), at("2026-11-20"));
      await recordPrMediaActivity(db, pr(1, "acme"), at("2026-11-25"));
      await recordPrMediaActivity(db, pr(2, "acme"), at("2026-11-25"));
      await recordPrMediaActivity(db, pr(3, "beta"), at("2026-11-25"));

      const { days } = await buildWorkspaceActivity(db, "acme", NOW);
      const byDay = Object.fromEntries(days.map((d) => [d.day, d.prs]));
      expect(byDay["2026-11-20"]).toBe(1);
      expect(byDay["2026-11-25"]).toBe(1);
      expect(days.reduce((n, d) => n + d.prs, 0)).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});

describe("withUploadTypes", () => {
  const activity = {
    uploadTypes: false,
    days: [
      { day: "2026-11-26", uploads: 3, prs: 0, comments: 0 },
      { day: "2026-11-27", uploads: 1, prs: 0, comments: 0 },
    ],
  };

  it("adds the split to the days Analytics Engine covers", () => {
    const merged = withUploadTypes(activity, {
      available: true,
      days: [{ day: "2026-11-27", image: 1, video: 0, other: 0 }],
    });
    expect(merged.uploadTypes).toBe(true);
    expect(merged.days[0]).not.toHaveProperty("types");
    expect(merged.days[1]!.types).toEqual({ image: 1, video: 0, other: 0 });
  });

  it("leaves the activity alone when Analytics Engine is unavailable", () => {
    expect(withUploadTypes(activity, { available: false, reason: "not_configured" })).toBe(
      activity,
    );
  });
});
