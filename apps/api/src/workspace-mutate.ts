/**
 * The single in-worker write path for `ws:<name>` workspace records (#387).
 *
 * The record is one KV blob holding unrelated field groups, so every mutation
 * is a read-modify-write and concurrent ones used to drop each other's changes.
 * Two mitigations: the read happens here, immediately before the write (slow
 * per-request work stays outside, shrinking the window to one KV round trip),
 * and after the `put` the key is read back — if the stored blob isn't the one
 * we wrote, another writer raced us and the mutation is re-applied on top of
 * *their* record, surfacing a 409 after `WORKSPACE_MUTATION_ATTEMPTS` losses.
 *
 * KV has no compare-and-swap, so this narrows the lost-update window rather
 * than closing it. See docs/workspaces.md § "Mutating a workspace record" for
 * what remains racy and why that's acceptable here; issue #389 tracks the
 * durable fix (moving the mutable field groups to D1).
 */
import { ConflictError, NotFoundError } from "@uploads/errors";
import { isPurgedTombstone, loadWorkspaceRecordRaw, type WorkspaceRecord } from "./workspace";

/** How many times a mutation is re-applied after losing a write race. */
export const WORKSPACE_MUTATION_ATTEMPTS = 3;

/**
 * Applied to the freshest record. Return the record to store, or `null` to
 * skip the write entirely (a no-op patch, or a sweep that found nothing to
 * change — no version bump, no wasted KV write). Throwing propagates to the
 * caller untouched, so state-dependent guards (409 `already_deleted`, 410
 * `grace_expired`) belong *inside* the mutation, where they see the record
 * that is actually about to be overwritten.
 *
 * Must be idempotent — a lost write re-runs it — and must not do I/O beyond
 * what computing the next record needs: it runs inside the window this module
 * exists to keep small. Deriving a field is fine (the credential re-encrypt
 * sweep reseals here, deliberately, so it seals the record it is about to
 * write); fetching unrelated state is not.
 */
export type WorkspaceMutation = (
  record: WorkspaceRecord,
) => WorkspaceRecord | null | Promise<WorkspaceRecord | null>;

export interface MutateWorkspaceOptions {
  /**
   * Reject soft-deleted records (`deletedAt`) with the same 404 as an unknown
   * workspace. Set for edits that only make sense on a serving workspace (an
   * admin can't tune limits on a workspace that no longer serves); leave off
   * for the delete/restore paths, which mutate exactly those records.
   */
  requireServing?: boolean;
}

/**
 * A record's optimistic-concurrency counter. Records written before versioning
 * (and any hand-edited blob with a non-integer `version`) count as 0, so the
 * first write through this module stamps 1 — no backfill needed.
 */
export function workspaceRecordVersion(record: WorkspaceRecord): number {
  const { version } = record;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/**
 * Read-modify-write `ws:<name>` with the concurrency handling described above.
 * Returns the stored record (including its new `version`), or the unchanged
 * record when the mutation returned `null`.
 */
export async function mutateWorkspaceRecord(
  env: Env,
  name: string,
  mutate: WorkspaceMutation,
  opts: MutateWorkspaceOptions = {},
): Promise<WorkspaceRecord> {
  const key = `ws:${name}`;

  for (let attempt = 1; attempt <= WORKSPACE_MUTATION_ATTEMPTS; attempt++) {
    const current = await loadWorkspaceRecordRaw(env, name);
    if (!current || isPurgedTombstone(current) || (opts.requireServing && current.deletedAt)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const mutated = await mutate(current);
    if (mutated === null) return current;

    const next: WorkspaceRecord = { ...mutated, version: workspaceRecordVersion(current) + 1 };
    const serialized = JSON.stringify(next);
    await env.REGISTRY.put(key, serialized);

    // Byte-compare rather than compare versions: two racing writers can land on
    // the same next version, and only the exact blob proves ours is the one
    // that stuck.
    const stored = await env.REGISTRY.get(key, "text");
    if (stored === serialized) return next;

    console.log(
      JSON.stringify({
        event: "workspace_record_write_lost",
        workspace: name,
        attempt,
        attempts: WORKSPACE_MUTATION_ATTEMPTS,
      }),
    );
  }

  throw new ConflictError("workspace record was modified concurrently; retry", {
    code: "workspace_record_conflict",
    details: { workspace: name },
  });
}
