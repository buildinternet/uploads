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
import { createStorage } from "@uploads/storage";
import { isSharedLane, storageConfigs } from "./storage";
import { getWorkspaceUsage, setUsageTotals, type WorkspaceUsage } from "./usage";
import { isUnprefixedDedicatedBucket, type WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

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
  const previous = await getWorkspaceUsage(dbFor(env), workspaceName, now);
  const configs = await storageConfigs(env, ws);
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

  // Every lane's walk is independent — run them concurrently and merge the
  // partial sums after, rather than one lane's (possibly remote, possibly
  // slow) listAll() blocking the next. Single-lane records still make
  // exactly the one walk this always has.
  const partials = await Promise.all(
    configs.map(async ({ config }) => {
      const store = createStorage(config);
      let bytes = 0;
      let objects = 0;
      // listAll follows list() cursors; each item is a StoredFile with size metadata.
      for await (const item of store.listAll()) {
        bytes += item.size ?? 0;
        objects += 1;
      }
      return { bytes, objects, shared: isSharedLane(config) };
    }),
  );

  let bytes = 0;
  let objects = 0;
  let sharedBytes = 0;
  let sharedObjects = 0;
  for (const partial of partials) {
    bytes += partial.bytes;
    objects += partial.objects;
    if (partial.shared) {
      sharedBytes += partial.bytes;
      sharedObjects += partial.objects;
    }
  }

  const usage = await setUsageTotals(
    dbFor(env),
    workspaceName,
    { bytes, objects, sharedBytes, sharedObjects },
    now,
  );
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
