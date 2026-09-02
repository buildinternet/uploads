/**
 * Shared in-memory `github_private_prefixes` table backing for route tests
 * (usage-fake-d1.ts) — mirrors the real D1 semantics (INSERT OR IGNORE
 * against a partial-unique "one active row per (repo, branch)" index, plus
 * rotation via `rotated_at`) without a full sqlite-backed D1. See
 * github-private-prefixes-sqlite.test.ts for the real-SQL-semantics
 * coverage.
 */

export interface PrivatePrefixRow {
  repo_full_name: string;
  branch: string;
  prefix_id: string;
  created_at: string;
  rotated_at: string | null;
}

export interface FakeRunResult {
  success: true;
  meta: { changes: number };
  results: [];
}

export interface FakeFirstResult<T> {
  success: true;
  results: T[];
  meta: Record<string, unknown>;
}

export interface FakeAllResult<T> {
  success: true;
  results: T[];
  meta: Record<string, unknown>;
}

export class PrivatePrefixesTable {
  // Keyed by (repo, branch, prefix_id) — the real table's primary key —
  // so a retired row and a freshly-minted one for the same (repo, branch)
  // coexist, matching the sqlite-backed suite.
  readonly rows = new Map<string, PrivatePrefixRow>();

  private rowKey(row: Pick<PrivatePrefixRow, "repo_full_name" | "branch" | "prefix_id">): string {
    return `${row.repo_full_name}\0${row.branch}\0${row.prefix_id}`;
  }

  private activeRow(repo: string, branch: string): PrivatePrefixRow | undefined {
    for (const row of this.rows.values()) {
      if (row.repo_full_name === repo && row.branch === branch && row.rotated_at === null) {
        return row;
      }
    }
    return undefined;
  }

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO github_private_prefixes")) {
      const [repo, branch, prefixId, createdAt] = args as [string, string, string, string];
      if (this.activeRow(repo, branch)) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      const row: PrivatePrefixRow = {
        repo_full_name: repo,
        branch,
        prefix_id: prefixId,
        created_at: createdAt,
        rotated_at: null,
      };
      this.rows.set(this.rowKey(row), row);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE github_private_prefixes SET rotated_at")) {
      const [rotatedAt, repo, branch, prefixId] = args as [string, string, string, string];
      const key = this.rowKey({ repo_full_name: repo, branch, prefix_id: prefixId });
      const row = this.rows.get(key);
      if (!row || row.rotated_at !== null) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      this.rows.set(key, { ...row, rotated_at: rotatedAt });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (
      normalizedSql.includes("FROM github_private_prefixes") &&
      normalizedSql.includes("branch = ?") &&
      normalizedSql.includes("rotated_at IS NULL")
    ) {
      const [repo, branch] = args as [string, string];
      const row = this.activeRow(repo, branch);
      return (row ? { prefix_id: row.prefix_id } : null) as T | null;
    }
    return undefined;
  }

  // listActivePrefixIds: every active row for a repo, across branches.
  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    // listPrefixIdsForTarget ownership filter (#934): which of the given ids
    // this repo minted, rotated or not. Args: (repo, ...ids).
    if (
      normalizedSql.includes("FROM github_private_prefixes") &&
      normalizedSql.includes("prefix_id IN (")
    ) {
      const [repo, ...ids] = args as [string, ...string[]];
      const wanted = new Set(ids);
      const results = [...this.rows.values()]
        .filter((row) => row.repo_full_name === repo && wanted.has(row.prefix_id))
        .map((row) => ({ prefix_id: row.prefix_id }));
      return { success: true, results: results as T[], meta: {} };
    }
    if (
      normalizedSql.includes("FROM github_private_prefixes") &&
      normalizedSql.includes("rotated_at IS NULL") &&
      !normalizedSql.includes("branch = ?")
    ) {
      const [repo] = args as [string];
      const results = [...this.rows.values()]
        .filter((row) => row.repo_full_name === repo && row.rotated_at === null)
        .map((row) => ({ prefix_id: row.prefix_id }));
      return { success: true, results: results as T[], meta: {} };
    }
    // listRetiredPrefixIds: every retired row for one (repo, branch),
    // oldest first — rotation's resumability sweep (issue #631, Task 8).
    if (
      normalizedSql.includes("FROM github_private_prefixes") &&
      normalizedSql.includes("rotated_at IS NOT NULL") &&
      normalizedSql.includes("branch = ?")
    ) {
      const [repo, branch] = args as [string, string];
      const results = [...this.rows.values()]
        .filter(
          (row) => row.repo_full_name === repo && row.branch === branch && row.rotated_at !== null,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((row) => ({ prefix_id: row.prefix_id }));
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
