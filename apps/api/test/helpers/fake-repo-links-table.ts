/**
 * Shared in-memory `github_repo_links` table backing for route/webhook tests
 * (usage-fake-d1.ts) — mirrors the real D1 semantics (INSERT OR IGNORE:
 * first claim wins) without a full sqlite-backed D1. See
 * github-repo-links-sqlite.test.ts for the real-SQL-semantics coverage.
 */

export interface RepoLinkRow {
  repo_full_name: string;
  workspace_name: string;
  installation_id: number | null;
  source: string;
  created_at: string;
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

export class RepoLinksTable {
  readonly rows = new Map<string, RepoLinkRow>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO github_repo_links")) {
      const [repo, workspace, installationId, source, createdAt] = args as [
        string,
        string,
        number | null,
        string,
        string,
      ];
      if (this.rows.has(repo)) return { success: true, meta: { changes: 0 }, results: [] };
      this.rows.set(repo, {
        repo_full_name: repo,
        workspace_name: workspace,
        installation_id: installationId,
        source,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    // Operator override (setRepoLink, issue #318): forcibly assigns/reassigns
    // a binding, overwriting any existing owner — mirrors the real D1
    // `ON CONFLICT ... DO UPDATE` in github-repo-links.ts.
    if (
      normalizedSql.startsWith("INSERT INTO github_repo_links") &&
      normalizedSql.includes("ON CONFLICT")
    ) {
      const [repo, workspace, installationId, source, createdAt] = args as [
        string,
        string,
        number | null,
        string,
        string,
      ];
      this.rows.set(repo, {
        repo_full_name: repo,
        workspace_name: workspace,
        installation_id: installationId,
        source,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    // Self-serve unlink (deleteRepoLinkForWorkspace, issue #318): only
    // deletes when the caller's workspace matches the current owner.
    if (
      normalizedSql.startsWith("DELETE FROM github_repo_links") &&
      normalizedSql.includes("workspace_name = ?")
    ) {
      const [repo, workspace] = args as [string, string];
      const row = this.rows.get(repo);
      if (!row || row.workspace_name !== workspace) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      this.rows.delete(repo);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("DELETE FROM github_repo_links")) {
      const [repo] = args as [string];
      const existed = this.rows.delete(repo);
      return { success: true, meta: { changes: existed ? 1 : 0 }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (normalizedSql.startsWith("SELECT * FROM github_repo_links WHERE repo_full_name")) {
      const [repo] = args as [string];
      return (this.rows.get(repo) as T) ?? null;
    }
    return undefined;
  }

  // listRepoLinksForWorkspace (issue #318, admin visibility): all bindings
  // owned by one workspace, newest first — matches the real `ORDER BY
  // created_at DESC`.
  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (normalizedSql.startsWith("SELECT * FROM github_repo_links WHERE workspace_name")) {
      const [workspace] = args as [string];
      // Non-mutating sort (see github-comment-render.ts: this worker's
      // tsconfig targets lib ES2022, which predates Array#toSorted).
      const results = [...this.rows.values()]
        .filter((row) => row.workspace_name === workspace)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
