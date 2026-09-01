/**
 * Shared in-memory `github_branch_renames` table backing for route/promote
 * tests (usage-fake-d1.ts) — mirrors the real D1 semantics (`INSERT OR
 * IGNORE` against a `COLLATE NOCASE` primary key, plus the
 * `new_branch`-keyed lookup the lineage walk issues) without a full
 * sqlite-backed D1. See github-branch-renames-sqlite.test.ts for the
 * real-SQL-semantics coverage.
 */

export interface BranchRenameRow {
  workspace: string;
  repo_full_name: string;
  old_branch: string;
  new_branch: string;
  source: string;
  recorded_at: string;
}

export interface FakeRunResult {
  success: true;
  meta: { changes: number };
  results: [];
}

export interface FakeAllResult<T> {
  success: true;
  results: T[];
  meta: Record<string, unknown>;
}

export class BranchRenamesTable {
  // Keyed by the real primary key, with the two NOCASE branch columns
  // lowercased so a case variant collides exactly as SQLite's would.
  readonly rows = new Map<string, BranchRenameRow>();

  private rowKey(row: BranchRenameRow): string {
    return [
      row.workspace,
      row.repo_full_name,
      row.old_branch.toLowerCase(),
      row.new_branch.toLowerCase(),
    ].join("\0");
  }

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (!normalizedSql.startsWith("INSERT OR IGNORE INTO github_branch_renames")) return undefined;
    const [workspace, repo, oldBranch, newBranch, source, recordedAt] = args as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const row: BranchRenameRow = {
      workspace,
      repo_full_name: repo,
      old_branch: oldBranch,
      new_branch: newBranch,
      source,
      recorded_at: recordedAt,
    };
    const key = this.rowKey(row);
    if (this.rows.has(key)) return { success: true, meta: { changes: 0 }, results: [] };
    this.rows.set(key, row);
    return { success: true, meta: { changes: 1 }, results: [] };
  }

  /** `resolveBranchLineage`'s one query: old names for a given new name. */
  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (!normalizedSql.includes("FROM github_branch_renames")) return undefined;
    const [workspace, repo, newBranch, limit] = args as [string, string, string, number];
    const matched = [...this.rows.values()]
      .filter(
        (row) =>
          row.workspace === workspace &&
          row.repo_full_name === repo &&
          row.new_branch.toLowerCase() === newBranch.toLowerCase(),
      )
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
      .map((row) => ({ old_branch: row.old_branch }));
    // The real query carries `LIMIT ?` (#920) — honor it so the fake can't
    // hand callers more rows than production would.
    const results = typeof limit === "number" ? matched.slice(0, limit) : matched;
    return { success: true, results: results as T[], meta: {} };
  }
}
