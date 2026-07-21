/**
 * Shared in-memory `github_pr_activity` table backing for route tests
 * (usage-fake-d1.ts) — mirrors the real upsert semantics (count increments,
 * first_media_at set once, COALESCE'd branch) without a sqlite-backed D1.
 * See ../github-pr-activity-sqlite.test.ts for real-SQL-semantics coverage.
 */

import type { FakeAllResult, FakeRunResult } from "./fake-repo-links-table";

export interface PrActivityRow {
  ref: string;
  repo_full_name: string;
  pr_number: number;
  branch: string | null;
  workspace_name: string;
  media_count: number;
  first_media_at: string;
  last_media_at: string;
}

export class PrActivityTable {
  readonly rows = new Map<string, PrActivityRow>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT INTO github_pr_activity")) {
      const [ref, repo, prNumber, branch, workspace, count, firstAt, lastAt] = args as [
        string,
        string,
        number,
        string | null,
        string,
        number,
        string,
        string,
      ];
      const existing = this.rows.get(ref);
      if (existing) {
        this.rows.set(ref, {
          ...existing,
          media_count: existing.media_count + count,
          branch: branch ?? existing.branch,
          workspace_name: workspace,
          last_media_at: lastAt,
        });
      } else {
        this.rows.set(ref, {
          ref,
          repo_full_name: repo,
          pr_number: prNumber,
          branch,
          workspace_name: workspace,
          media_count: count,
          first_media_at: firstAt,
          last_media_at: lastAt,
        });
      }
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    return undefined;
  }

  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (
      normalizedSql.includes("FROM github_pr_activity") &&
      normalizedSql.includes("workspace_name")
    ) {
      const [workspace, limit] = args as [string, number];
      // Copy + sort: lib ES2022 predates Array#toSorted.
      const results = [...this.rows.values()]
        .filter((row) => row.workspace_name === workspace)
        .sort((a, b) => b.last_media_at.localeCompare(a.last_media_at))
        .slice(0, limit);
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
