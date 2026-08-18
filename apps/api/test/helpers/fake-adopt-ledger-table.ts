/**
 * Shared in-memory `github_adopted_links` table backing for route/queue
 * tests (usage-fake-d1.ts) — mirrors the real D1 semantics (INSERT OR
 * IGNORE keyed on (repo, kind, num, source_key); UPDATE for detach/source)
 * without a full sqlite-backed D1. Structurally a twin of
 * fake-ingest-ledger-table.ts, scoped by target instead of asset id.
 */

export interface AdoptLedgerDbRow {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  source_key: string;
  workspace: string;
  object_key: string;
  source: string;
  created_at: string;
  detached_at: string | null;
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

function key(repo: string, kind: string, num: number, sourceKey: string): string {
  return `${repo}::${kind}::${num}::${sourceKey}`;
}

export class AdoptLedgerTable {
  readonly rows = new Map<string, AdoptLedgerDbRow>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO github_adopted_links")) {
      const [repo, kind, num, sourceKey, workspace, objectKey, source, createdAt] = args as [
        string,
        "pull" | "issues",
        number,
        string,
        string,
        string,
        string,
        string,
      ];
      const k = key(repo, kind, num, sourceKey);
      if (this.rows.has(k)) return { success: true, meta: { changes: 0 }, results: [] };
      this.rows.set(k, {
        repo,
        kind,
        num,
        source_key: sourceKey,
        workspace,
        object_key: objectKey,
        source,
        created_at: createdAt,
        detached_at: null,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("UPDATE github_adopted_links SET detached_at = ?") &&
      normalizedSql.includes("WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?")
    ) {
      const [detachedAt, repo, kind, num, sourceKey] = args as [
        string | null,
        string,
        "pull" | "issues",
        number,
        string,
      ];
      const row = this.rows.get(key(repo, kind, num, sourceKey));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.detached_at = detachedAt;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("UPDATE github_adopted_links SET source = ?") &&
      normalizedSql.includes("WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?")
    ) {
      const [source, repo, kind, num, sourceKey] = args as [
        string,
        string,
        "pull" | "issues",
        number,
        string,
      ];
      const row = this.rows.get(key(repo, kind, num, sourceKey));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.source = source;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (
      normalizedSql.includes(
        "FROM github_adopted_links WHERE repo = ? AND kind = ? AND num = ? AND source_key = ?",
      )
    ) {
      const [repo, kind, num, sourceKey] = args as [string, "pull" | "issues", number, string];
      return (this.rows.get(key(repo, kind, num, sourceKey)) as T) ?? null;
    }
    return undefined;
  }

  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (
      normalizedSql.includes(
        "FROM github_adopted_links WHERE repo = ? AND kind = ? AND num = ? AND source = ?",
      )
    ) {
      const [repo, kind, num, source] = args as [string, "pull" | "issues", number, string];
      const results = [...this.rows.values()].filter(
        (row) => row.repo === repo && row.kind === kind && row.num === num && row.source === source,
      );
      return { success: true, results: results as T[], meta: {} };
    }
    if (
      normalizedSql.includes("FROM github_adopted_links WHERE repo = ? AND kind = ? AND num = ?")
    ) {
      const [repo, kind, num] = args as [string, "pull" | "issues", number];
      const results = [...this.rows.values()].filter(
        (row) => row.repo === repo && row.kind === kind && row.num === num,
      );
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
