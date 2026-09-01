/// <reference types="node" />

/**
 * Real-SQL coverage for the branch-rename alias table (#920): the
 * `COLLATE NOCASE` primary key's dedupe, `INSERT OR IGNORE`'s
 * `recorded:false`, and the lineage BFS (chain, fan-in, cycle, caps).
 */

import { describe, expect, it } from "vitest";
import {
  recordBranchRename,
  resolveBranchLineage,
  resolveBranchLineageSafe,
} from "../src/github-branch-renames";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260901120000_github_branch_renames.sql"];
const WS = "acme";
const REPO = "acme/web";

function db() {
  const sqlite = new SqliteD1(MIGRATIONS);
  return { sqlite, db: database(sqlite) };
}

const rename = (from: string, to: string) => ({
  workspace: WS,
  repo: REPO,
  from,
  to,
  source: "cli-reflog",
});

describe("github branch renames (#920)", () => {
  it("records a rename once; a duplicate reports recorded:false", async () => {
    const { sqlite, db: d } = db();
    try {
      expect(await recordBranchRename(d, rename("old", "new"))).toEqual({ recorded: true });
      expect(await recordBranchRename(d, rename("old", "new"))).toEqual({ recorded: false });
      // COLLATE NOCASE on both branch columns — a case variant is the same row.
      expect(await recordBranchRename(d, rename("OLD", "New"))).toEqual({ recorded: false });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a rename whose from and to differ only by case", async () => {
    const { sqlite, db: d } = db();
    try {
      await expect(recordBranchRename(d, rename("feat", "FEAT"))).rejects.toMatchObject({
        code: "same_branch",
      });
    } finally {
      sqlite.close();
    }
  });

  it("scopes rows by workspace and repo", async () => {
    const { sqlite, db: d } = db();
    try {
      await recordBranchRename(d, { ...rename("old", "new"), workspace: "other" });
      await recordBranchRename(d, { ...rename("old", "new"), repo: "acme/other" });
      expect(await resolveBranchLineage(d, WS, REPO, "new")).toEqual(["new"]);
      expect(await resolveBranchLineage(d, "other", REPO, "new")).toEqual(["new", "old"]);
    } finally {
      sqlite.close();
    }
  });

  it("returns [branch] when the table is empty", async () => {
    const { sqlite, db: d } = db();
    try {
      expect(await resolveBranchLineage(d, WS, REPO, "feat-x")).toEqual(["feat-x"]);
    } finally {
      sqlite.close();
    }
  });

  it("walks a chained rename newest-first", async () => {
    const { sqlite, db: d } = db();
    try {
      await recordBranchRename(d, rename("a", "b"));
      await recordBranchRename(d, rename("b", "c"));
      await recordBranchRename(d, rename("c", "d"));
      expect(await resolveBranchLineage(d, WS, REPO, "d")).toEqual(["d", "c", "b", "a"]);
      // Mid-chain start only walks backwards from there.
      expect(await resolveBranchLineage(d, WS, REPO, "b")).toEqual(["b", "a"]);
    } finally {
      sqlite.close();
    }
  });

  it("matches the queried branch case-insensitively", async () => {
    const { sqlite, db: d } = db();
    try {
      await recordBranchRename(d, rename("Old-Name", "New-Name"));
      expect(await resolveBranchLineage(d, WS, REPO, "new-name")).toEqual(["new-name", "Old-Name"]);
    } finally {
      sqlite.close();
    }
  });

  it("is cycle-safe", async () => {
    const { sqlite, db: d } = db();
    try {
      await recordBranchRename(d, rename("a", "b"));
      await recordBranchRename(d, rename("b", "a"));
      expect(await resolveBranchLineage(d, WS, REPO, "a")).toEqual(["a", "b"]);
    } finally {
      sqlite.close();
    }
  });

  it("dedupes case variants across the walk", async () => {
    const { sqlite, db: d } = db();
    try {
      await recordBranchRename(d, rename("a", "b"));
      await recordBranchRename(d, rename("A-ALT", "b"));
      await recordBranchRename(d, rename("a", "A-ALT"));
      const lineage = await resolveBranchLineage(d, WS, REPO, "b");
      expect(lineage[0]).toBe("b");
      expect(new Set(lineage.map((n) => n.toLowerCase())).size).toBe(lineage.length);
    } finally {
      sqlite.close();
    }
  });

  it("caps the walk at depth 8", async () => {
    const { sqlite, db: d } = db();
    try {
      // n0 <- n1 <- … <- n11 (a 12-link chain, deeper than the depth cap).
      for (let i = 0; i < 12; i++) await recordBranchRename(d, rename(`n${i}`, `n${i + 1}`));
      const lineage = await resolveBranchLineage(d, WS, REPO, "n12");
      expect(lineage).toHaveLength(9); // the branch itself + 8 hops
      expect(lineage[0]).toBe("n12");
      expect(lineage.at(-1)).toBe("n4");
    } finally {
      sqlite.close();
    }
  });

  it("caps the total lineage at 16 names", async () => {
    const { sqlite, db: d } = db();
    try {
      // A wide fan-in: 40 distinct old names all renamed to "wide".
      for (let i = 0; i < 40; i++) await recordBranchRename(d, rename(`old-${i}`, "wide"));
      const lineage = await resolveBranchLineage(d, WS, REPO, "wide");
      expect(lineage).toHaveLength(16);
      expect(lineage[0]).toBe("wide");
    } finally {
      sqlite.close();
    }
  });

  it("never fetches more rows than the total cap can still absorb", async () => {
    const { sqlite, db: d } = db();
    try {
      for (let i = 0; i < 200; i++) await recordBranchRename(d, rename(`old-${i}`, "wide"));
      // Count what each lineage query actually returns — a missing LIMIT
      // would materialize all 200 rows for a walk that can use 15.
      const pageSizes: number[] = [];
      const counting = {
        prepare: (sql: string) => {
          const stmt = d.prepare(sql);
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: () => bound.first(),
                run: () => bound.run(),
                all: async <T>() => {
                  const result = await bound.all<T>();
                  pageSizes.push(result.results.length);
                  return result;
                },
              };
            },
          };
        },
        batch: async () => [],
      };

      const lineage = await resolveBranchLineage(
        counting as unknown as Parameters<typeof resolveBranchLineage>[0],
        WS,
        REPO,
        "wide",
      );

      expect(lineage).toHaveLength(16);
      expect(Math.max(...pageSizes)).toBeLessThanOrEqual(15);
    } finally {
      sqlite.close();
    }
  });

  it("resolveBranchLineageSafe falls back to [branch] on a lookup error", async () => {
    const throwing = {
      prepare: () => {
        throw new Error("simulated D1 outage");
      },
      batch: async () => [],
    };
    expect(await resolveBranchLineageSafe(throwing, WS, REPO, "feat-x")).toEqual(["feat-x"]);
  });
});
