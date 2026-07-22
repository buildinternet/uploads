/**
 * The single write path for `ws:<name>` workspace records (issue #387).
 *
 * Every mutation of a workspace record is a read-modify-write against a KV
 * blob that holds unrelated field groups — budget limits, plan, GitHub-comment
 * settings, tokens, soft-delete stamps. Handlers used to load the record at the
 * top of a request, do slow work (parse the body, validate, hit D1, call the
 * auth worker), then `put` the whole snapshot back. Two concurrent mutations
 * could interleave so the later `put` silently dropped the earlier one's change
 * — an admin's limit edit vanishing because a plan change landed in between.
 *
 * Workers KV has no compare-and-swap, so this closes the window rather than
 * eliminating it, in two ways:
 *
 * 1. **The read happens here, immediately before the write.** All the slow
 *    per-request work stays outside, so the vulnerable window shrinks from the
 *    whole handler to one KV round trip. The mutation always sees the freshest
 *    record, so a field group it doesn't touch can't be reverted to a stale value.
 * 2. **Write, verify, retry.** Each record carries a monotonic `version`. After
 *    the `put` we read the key back: if the stored blob isn't the one we just
 *    wrote, another writer raced us, and we re-run the mutation on top of *their*
 *    record instead of leaving our change dropped. After
 *    `WORKSPACE_MUTATION_ATTEMPTS` losses we surface a 409 rather than loop.
 *
 * What remains racy: KV is eventually consistent, so the verification read can
 * in principle return a value that isn't yet globally settled, and two writers
 * can still interleave inside the read-verify window. That is acceptable for
 * this surface — these are admin/owner-initiated, low-concurrency mutations.
 * The durable fix is moving the record to D1 (see issue #387's third option).
 */
import { AppError, NotFoundError } from "@uploads/errors";
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
 * Must be cheap and free of unrelated I/O: it runs inside the window this
 * module exists to keep small, and it may run more than once.
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

function conflict(name: string): AppError {
  return new AppError({
    type: "conflict",
    code: "workspace_record_conflict",
    message: "workspace record was modified concurrently; retry",
    status: 409,
    details: { workspace: name },
  });
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

  throw conflict(name);
}
