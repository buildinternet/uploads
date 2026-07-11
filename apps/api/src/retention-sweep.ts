/**
 * Daily retention sweep: every REGISTRY workspace with retentionDays set runs
 * purgeExpiredObjects. Invoked from the Worker scheduled handler.
 */
import { purgeExpiredObjects } from "./retention";
import type { WorkspaceRecord } from "./workspace";

export interface SweepResult {
  workspacesScanned: number;
  workspacesWithRetention: number;
  purged: Array<{
    workspace: string;
    deleted: number;
    freedBytes: number;
    skipped?: boolean;
    error?: string;
  }>;
}

export async function runRetentionSweep(env: Env): Promise<SweepResult> {
  let cursor: string | undefined;
  let workspacesScanned = 0;
  let workspacesWithRetention = 0;
  const purged: SweepResult["purged"] = [];

  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      workspacesScanned += 1;
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (!name) continue;

      let record: WorkspaceRecord | null = null;
      try {
        record = await env.REGISTRY.get<WorkspaceRecord>(entry.name, "json");
      } catch (err) {
        purged.push({
          workspace: name,
          deleted: 0,
          freedBytes: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!record) continue;
      if (typeof record.retentionDays !== "number" || record.retentionDays <= 0) continue;

      workspacesWithRetention += 1;
      try {
        const result = await purgeExpiredObjects(env, record, name);
        if ("skipped" in result) {
          purged.push({ workspace: name, deleted: 0, freedBytes: 0, skipped: true });
        } else {
          purged.push({
            workspace: name,
            deleted: result.deleted,
            freedBytes: result.freedBytes,
          });
        }
      } catch (err) {
        purged.push({
          workspace: name,
          deleted: 0,
          freedBytes: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(
    JSON.stringify({
      message: "retention_sweep",
      workspacesScanned,
      workspacesWithRetention,
      purged,
    }),
  );
  return { workspacesScanned, workspacesWithRetention, purged };
}
