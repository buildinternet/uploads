/**
 * Shared D1 stand-in for workspace_usage (INSERT OR IGNORE + UPDATE batch)
 * and optional no-op auth_tokens lookups for route tests.
 */

import { FileMetadataTable } from "./helpers/fake-file-metadata-table";

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
  // usage ledger.
  private fileMetadataTable = new FileMetadataTable();
  get fileMetadata() {
    return this.fileMetadataTable.metadata;
  }

  prepare = (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    let values: unknown[] = [];

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
        const result = this.fileMetadataTable.tryAll<T>(normalized, values);
        if (result) return result;
        throw new Error(`unsupported all: ${normalized}`);
      },
      run: async () => {
        const metaResult = this.fileMetadataTable.tryRun(normalized, values);
        if (metaResult) return metaResult;
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
          // Guarded reservation from reserveUploads: increments
          // uploads_in_period only while within the cap; changes: 0 signals
          // a spent budget. Atomic within a single run(), like D1's UPDATE.
          if (normalized.includes("<= ?")) {
            const [period, count, periodSet, updatedAt, workspace, , , max] = values as [
              string,
              number,
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            const row = this.usage.get(workspace);
            if (!row) throw new Error(`update before insert for ${workspace}`);
            const current = row.period_start === period ? row.uploads_in_period : 0;
            if (current + count > max) {
              return { success: true as const, meta: { changes: 0 }, results: [] };
            }
            this.usage.set(workspace, {
              ...row,
              uploads_in_period: current + count,
              period_start: periodSet,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Reservation release from releaseUploadsSafe: same-period
          // decrement clamped at zero; a rolled-over period is a no-op.
          if (normalized.includes("MAX(0, uploads_in_period - ?)")) {
            const [period, count, updatedAt, workspace] = values as [
              string,
              number,
              string,
              string,
            ];
            const row = this.usage.get(workspace);
            if (!row) return { success: true as const, meta: { changes: 0 }, results: [] };
            this.usage.set(workspace, {
              ...row,
              uploads_in_period:
                row.period_start === period
                  ? Math.max(0, row.uploads_in_period - count)
                  : row.uploads_in_period,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
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
