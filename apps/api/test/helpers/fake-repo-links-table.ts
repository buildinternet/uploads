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
    if (normalizedSql.startsWith("DELETE FROM github_repo_links")) {
      const [repo] = args as [string];
      const existed = this.rows.delete(repo);
      return { success: true, meta: { changes: existed ? 1 : 0 }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (normalizedSql.startsWith("SELECT * FROM github_repo_links")) {
      const [repo] = args as [string];
      return (this.rows.get(repo) as T) ?? null;
    }
    return undefined;
  }
}
