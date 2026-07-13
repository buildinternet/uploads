/**
 * Shared D1 stand-in for workspace_usage (INSERT OR IGNORE + UPDATE batch)
 * and optional no-op auth_tokens lookups for route tests.
 */

export type UsageRow = {
  workspace: string;
  bytes: number;
  objects: number;
  uploads_in_period: number;
  period_start: string;
  updated_at: string;
};

export class UsageFakeD1 {
  usage = new Map<string, UsageRow>();
  // Backs `file_metadata` so putObject/deleteObject's D1 metadata
  // cascade (Task 2) doesn't blow up in suites that only care about the
  // usage ledger. Keyed by `${workspace} ${objectKey}`.
  fileMetadata = new Map<string, Map<string, string>>();

  prepare = (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    let values: unknown[] = [];
    const metaScopeKey = (workspace: string, objectKey: string) => `${workspace} ${objectKey}`;

    const stmt = {
      bind: (...v: unknown[]) => {
        values = v;
        return stmt;
      },
      first: async () => {
        if (normalized.includes("FROM auth_tokens")) return null;
        if (normalized.includes("FROM workspace_usage")) {
          return this.usage.get(values[0] as string) ?? null;
        }
        throw new Error(`unsupported first: ${normalized}`);
      },
      all: async <T>() => {
        if (normalized.startsWith("SELECT meta_key, meta_value FROM file_metadata")) {
          const [workspace, objectKey] = values as [string, string];
          const map = this.fileMetadata.get(metaScopeKey(workspace, objectKey)) ?? new Map();
          return {
            success: true as const,
            results: [...map.entries()].map(([meta_key, meta_value]) => ({
              meta_key,
              meta_value,
            })) as T[],
            meta: {},
          };
        }
        throw new Error(`unsupported all: ${normalized}`);
      },
      run: async () => {
        if (normalized.startsWith("INSERT INTO file_metadata")) {
          const [workspace, objectKey, key, value] = values as [string, string, string, string];
          const scope = metaScopeKey(workspace, objectKey);
          const map = this.fileMetadata.get(scope) ?? new Map<string, string>();
          map.set(key, value);
          this.fileMetadata.set(scope, map);
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (
          normalized.startsWith("DELETE FROM file_metadata") &&
          normalized.includes("meta_key = ?")
        ) {
          const [workspace, objectKey, key] = values as [string, string, string];
          this.fileMetadata.get(metaScopeKey(workspace, objectKey))?.delete(key);
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("DELETE FROM file_metadata")) {
          const [workspace, objectKey] = values as [string, string];
          this.fileMetadata.delete(metaScopeKey(workspace, objectKey));
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("INSERT OR IGNORE INTO workspace_usage")) {
          // applyUsageDelta: (ws, period, updatedAt) with zeros
          // setUsageTotals: (ws, bytes, objects, period, updatedAt)
          if (values.length === 3) {
            const [workspace, period, updatedAt] = values as [string, string, string];
            if (!this.usage.has(workspace)) {
              this.usage.set(workspace, {
                workspace,
                bytes: 0,
                objects: 0,
                uploads_in_period: 0,
                period_start: period,
                updated_at: updatedAt,
              });
            }
          } else {
            const [workspace, bytes, objects, period, updatedAt] = values as [
              string,
              number,
              number,
              string,
              string,
            ];
            if (!this.usage.has(workspace)) {
              this.usage.set(workspace, {
                workspace,
                bytes,
                objects,
                uploads_in_period: 0,
                period_start: period,
                updated_at: updatedAt,
              });
            }
          }
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("UPDATE workspace_usage SET")) {
          // Absolute totals from setUsageTotals: bytes, objects, updated_at, workspace
          if (
            normalized.includes("bytes = ?") &&
            normalized.includes("objects = ?") &&
            !normalized.includes("bytes +")
          ) {
            const [bytes, objects, updatedAt, workspace] = values as [
              number,
              number,
              string,
              string,
            ];
            const row = this.usage.get(workspace);
            if (!row) throw new Error(`update before insert for ${workspace}`);
            this.usage.set(workspace, {
              ...row,
              bytes,
              objects,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Delta apply from applyUsageDelta
          const [
            dBytes,
            dObjects,
            period,
            dUploadsAdd,
            dUploadsNew,
            periodSet,
            updatedAt,
            workspace,
          ] = values as [number, number, string, number, number, string, string, string];
          const row = this.usage.get(workspace);
          if (!row) throw new Error(`update before insert for ${workspace}`);
          const samePeriod = row.period_start === period;
          this.usage.set(workspace, {
            workspace,
            bytes: Math.max(0, row.bytes + dBytes),
            objects: Math.max(0, row.objects + dObjects),
            uploads_in_period: samePeriod
              ? row.uploads_in_period + dUploadsAdd
              : Math.max(0, dUploadsNew),
            period_start: periodSet,
            updated_at: updatedAt,
          });
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        throw new Error(`unsupported run: ${normalized}`);
      },
    };
    return stmt;
  };

  batch = async (statements: { run: () => Promise<unknown> }[]) => {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  };
}
