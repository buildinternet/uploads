/**
 * Shared in-memory `github_ingested_assets` table backing for route/queue
 * tests (usage-fake-d1.ts) — mirrors the real D1 semantics (INSERT OR
 * IGNORE keyed on (repo, asset_id); UPDATE for detach/source) without a
 * full sqlite-backed D1. See github-ingest-ledger-sqlite.test.ts for the
 * real-SQL-semantics coverage.
 */

export interface IngestLedgerDbRow {
  repo: string;
  asset_id: string;
  workspace: string;
  object_key: string;
  kind: "pull" | "issues";
  num: number;
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

function key(repo: string, assetId: string): string {
  return `${repo}::${assetId}`;
}

export class IngestLedgerTable {
  readonly rows = new Map<string, IngestLedgerDbRow>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO github_ingested_assets")) {
      const [repo, assetId, workspace, objectKey, kind, num, source, createdAt] = args as [
        string,
        string,
        string,
        string,
        "pull" | "issues",
        number,
        string,
        string,
      ];
      const k = key(repo, assetId);
      if (this.rows.has(k)) return { success: true, meta: { changes: 0 }, results: [] };
      this.rows.set(k, {
        repo,
        asset_id: assetId,
        workspace,
        object_key: objectKey,
        kind,
        num,
        source,
        created_at: createdAt,
        detached_at: null,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("UPDATE github_ingested_assets SET detached_at = ?") &&
      normalizedSql.includes("WHERE repo = ? AND asset_id = ?")
    ) {
      const [detachedAt, repo, assetId] = args as [string | null, string, string];
      const row = this.rows.get(key(repo, assetId));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.detached_at = detachedAt;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("UPDATE github_ingested_assets SET source = ?") &&
      normalizedSql.includes("WHERE repo = ? AND asset_id = ?")
    ) {
      const [source, repo, assetId] = args as [string, string, string];
      const row = this.rows.get(key(repo, assetId));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.source = source;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("UPDATE github_ingested_assets SET object_key = ?") &&
      normalizedSql.includes("WHERE object_key = ?")
    ) {
      // Rotation's rename-in-place (issue #631, Task 8) — the row stays
      // keyed by (repo, asset_id); only its object_key column changes.
      const [newObjectKey, oldObjectKey] = args as [string, string];
      let changes = 0;
      for (const row of this.rows.values()) {
        if (row.object_key === oldObjectKey) {
          row.object_key = newObjectKey;
          changes++;
        }
      }
      return { success: true, meta: { changes }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (normalizedSql.includes("FROM github_ingested_assets WHERE repo = ? AND asset_id = ?")) {
      const [repo, assetId] = args as [string, string];
      return (this.rows.get(key(repo, assetId)) as T) ?? null;
    }
    return undefined;
  }

  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (normalizedSql.includes("FROM github_ingested_assets WHERE repo = ? AND source = ?")) {
      const [repo, source] = args as [string, string];
      const results = [...this.rows.values()].filter(
        (row) => row.repo === repo && row.source === source,
      );
      return { success: true, results: results as T[], meta: {} };
    }
    if (
      normalizedSql.includes("FROM github_ingested_assets WHERE repo = ? AND kind = ? AND num = ?")
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
