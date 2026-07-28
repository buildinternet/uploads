/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { bumpDailyMetric, recordAdoptionSafe, utcDay } from "../src/adoption";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260728120000_daily_metrics.sql";

interface Row {
  metric: string;
  day: string;
  workspace: string;
  count: number;
  bytes: number;
}

async function rows(db: D1Database): Promise<Row[]> {
  const result = await db
    .prepare(
      `SELECT metric, day, workspace, count, bytes FROM daily_metrics ORDER BY metric, day, workspace`,
    )
    .all<Row>();
  return result.results;
}

describe("utcDay", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date("2026-07-28T23:59:59.000Z"))).toBe("2026-07-28");
  });

  it("rolls over on the UTC boundary, not local time", () => {
    expect(utcDay(new Date("2026-07-29T00:00:00.000Z"))).toBe("2026-07-29");
  });
});

describe("bumpDailyMetric", () => {
  it("writes both a workspace row and a platform row", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "acme", bytes: 100 },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 1, bytes: 100 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 1, bytes: 100 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("accumulates repeat events into the same rows", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 100 }, at);
      await bumpDailyMetric(db, { metric: "upload", workspace: "acme", bytes: 50 }, at);
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 2, bytes: 150 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 2, bytes: 150 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("separates days and keeps workspaces independent", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "acme", bytes: 10 },
        new Date("2026-07-28T10:00:00Z"),
      );
      await bumpDailyMetric(
        db,
        { metric: "upload", workspace: "beta", bytes: 20 },
        new Date("2026-07-29T10:00:00Z"),
      );
      expect(await rows(db)).toEqual([
        { metric: "upload", day: "2026-07-28", workspace: "", count: 1, bytes: 10 },
        { metric: "upload", day: "2026-07-28", workspace: "acme", count: 1, bytes: 10 },
        { metric: "upload", day: "2026-07-29", workspace: "", count: 1, bytes: 20 },
        { metric: "upload", day: "2026-07-29", workspace: "beta", count: 1, bytes: 20 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("stores deletes as positive bytes under their own metric", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const at = new Date("2026-07-28T10:00:00Z");
      await bumpDailyMetric(db, { metric: "delete", workspace: "acme", bytes: 400 }, at);
      const all = await rows(db);
      expect(all.every((row) => row.bytes >= 0 && row.count >= 0)).toBe(true);
      expect(all).toContainEqual({
        metric: "delete",
        day: "2026-07-28",
        workspace: "acme",
        count: 1,
        bytes: 400,
      });
    } finally {
      sqlite.close();
    }
  });

  it("defaults bytes to 0 for non-byte metrics", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "workspace_created", workspace: "acme" },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toContainEqual({
        metric: "workspace_created",
        day: "2026-07-28",
        workspace: "acme",
        count: 1,
        bytes: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("clamps a negative byte figure to 0 rather than storing it", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      await bumpDailyMetric(
        db,
        { metric: "delete", workspace: "acme", bytes: -400 },
        new Date("2026-07-28T10:00:00Z"),
      );
      const all = await rows(db);
      expect(all.every((row) => row.bytes === 0)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

describe("recordAdoptionSafe", () => {
  it("swallows and logs a D1 failure instead of throwing", async () => {
    const failing = {
      prepare: () => {
        throw new Error("D1 exploded");
      },
    } as unknown as D1Database;
    const env = { DB: failing } as unknown as Env;
    await expect(
      recordAdoptionSafe(env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).resolves.toBeUndefined();
  });

  it("writes through to D1 on the happy path", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const db = database(sqlite);
      const env = { DB: db } as unknown as Env;
      await recordAdoptionSafe(
        env,
        { metric: "upload", workspace: "acme", bytes: 7 },
        new Date("2026-07-28T10:00:00Z"),
      );
      expect(await rows(db)).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  it("is a no-op, not a crash, when the ANALYTICS binding is absent", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const env = { DB: database(sqlite) } as unknown as Env;
      await expect(
        recordAdoptionSafe(env, {
          metric: "upload",
          workspace: "acme",
          bytes: 7,
          dimensions: { surface: "api", contentType: "image/png" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});
