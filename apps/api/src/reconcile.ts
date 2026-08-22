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
import { isUnprefixedDedicatedBucket, type WorkspaceRecord } from "./workspace";

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
  /**
   * True when this workspace has no `prefix` — the listAll() walk below
   * scans an entire dedicated bucket rather than a confined slice. This
   * function is only ever invoked on-demand for a single workspace today
   * (no bulk/scheduled caller), so behavior is unchanged; the flag just
   * makes a surprisingly large remote list diagnosable if a BYO bucket ever
   * triggers one.
   */
  unprefixedBucket?: boolean;
}

/** Walk every object under the workspace prefix and replace ledger bytes/objects. */
export async function reconcileWorkspaceUsage(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const previous = await getWorkspaceUsage(env.DB, workspaceName, now);
  // PR D: walks the active lane only. Two-lane storage (PR C) means a
  // workspace can also have fallback lanes holding objects, which this scan
  // does not see — reconcile stays active-lane-only until PR D's
  // `shared_bytes` ledger work makes it lane-aware (spec: "Usage / budget
  // attribution"). Not a regression: this function's only caller today is
  // on-demand, single-workspace, and always was active-lane-only.
  const store = await storage(env, ws);
  const unprefixedBucket = isUnprefixedDedicatedBucket(ws);
  if (unprefixedBucket) {
    console.log(
      JSON.stringify({
        event: "reconcile_unprefixed_bucket_scan",
        workspace: workspaceName,
        bucket: ws.bucket,
      }),
    );
  }

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
    unprefixedBucket: unprefixedBucket || undefined,
  };
}
