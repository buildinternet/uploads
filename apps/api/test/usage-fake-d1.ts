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
      run: async () => {
        if (normalized.startsWith("INSERT OR IGNORE INTO workspace_usage")) {
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
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("UPDATE workspace_usage SET")) {
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
