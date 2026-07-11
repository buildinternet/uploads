/**
 * Rebuild workspace storage totals from the object store (source of truth).
 * Fixes ledger drift from failed metering, external deletes, or races.
 * Does not change monthly `uploadsInPeriod`.
 *
 * files-sdk: uses `listAll()` on the workspace-scoped `Files` instance
 * (`createStorage` already applies `prefix`). Listing returns `size` on the
 * metadata without fetching bodies — do not call body accessors during the walk.
 * The in-memory `files-sdk/usage` plugin is not used: it does not survive
 * across Worker isolates and does not track net storage after deletes.
 */
import { storage } from "./storage";
import { getWorkspaceUsage, setUsageTotals, type WorkspaceUsage } from "./usage";
import type { WorkspaceRecord } from "./workspace";

export interface ReconcileResult {
  workspace: string;
  /** Totals scanned from storage. */
  bytes: number;
  objects: number;
  /** Ledger before the write. */
  previous: { bytes: number; objects: number };
  /** True when bytes or objects changed. */
  changed: boolean;
  usage: WorkspaceUsage;
}

/** Walk every object under the workspace prefix and replace ledger bytes/objects. */
export async function reconcileWorkspaceUsage(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const previous = await getWorkspaceUsage(env.DB, workspaceName, now);
  const store = await storage(env, ws);

  let bytes = 0;
  let objects = 0;
  // listAll follows list() cursors; each item is a StoredFile with size metadata.
  for await (const item of store.listAll()) {
    bytes += item.size ?? 0;
    objects += 1;
  }

  const usage = await setUsageTotals(env.DB, workspaceName, { bytes, objects }, now);
  return {
    workspace: workspaceName,
    bytes,
    objects,
    previous: { bytes: previous.bytes, objects: previous.objects },
    changed: previous.bytes !== bytes || previous.objects !== objects,
    usage,
  };
}
