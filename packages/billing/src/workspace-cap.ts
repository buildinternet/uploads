/**
 * Workspace-creation soft cap (spec 2026-07-24). Pure — no I/O — so the
 * `POST /v1/workspaces` guard and the `/me/workspaces` listing that tells
 * the UI whether to offer creation share one answer to "may this user
 * create another workspace".
 *
 * Sibling to `member-cap.ts`, and for the same reason: `plan` is only ever
 * written by Stripe (`/internal/billing/plan`) or an operator (`PATCH
 * /admin-ui/workspaces/:name/plan`), while self-serve provisioning writes
 * free's numeric limits and no `plan` field at all. `selfServe` is the
 * honest signal for "a free tenant that never had a plan stamped on it",
 * and `getPlan`'s fail-open-to-free keeps such a record on the free side of
 * the test.
 */
import { getPlan } from "./plans";

/** Free workspaces one user may own at a time. */
export const MAX_SELF_SERVE_WORKSPACES = 3;

/** The shape the cap needs from a workspace record — a subset of apps/api's
 * `WorkspaceRecord`, restated here so this package keeps its independence
 * from `@uploads/api`. */
export interface WorkspaceCapRecord {
  /** Subscription plan, when one has been stamped. */
  plan?: string;
  /** True for workspaces provisioned by the self-serve flow. */
  selfServe?: boolean;
}

export interface WorkspaceCreateQuota {
  /** Cap-eligible workspaces the user owns. May exceed `cap` after a
   * downgrade — see `resolveWorkspaceCreateQuota`. */
  used: number;
  cap: number;
  allowed: boolean;
}

/**
 * True when this record burns one of the user's free slots: provisioned by
 * self-serve and still resolving to the free plan.
 *
 * Exempt, deliberately: paid workspaces (the whole point of the exemption),
 * and legacy/operator-provisioned records with no `selfServe` flag, which
 * keep the unlimited posture they have in production today.
 */
function isCapEligible(record: WorkspaceCapRecord | null | undefined): boolean {
  // A record that could not be loaded cannot be shown to be cap-eligible;
  // fail open rather than charge a user for a KV miss.
  if (!record) return false;
  if (record.selfServe !== true) return false;
  return getPlan(record.plan).id === "free";
}

/**
 * How many of `records` count against the allowance. Callers pass records
 * for workspaces the user **owns** — the role filter stays at the call
 * site, where membership data lives.
 */
export function countCapEligibleWorkspaces(
  records: readonly (WorkspaceCapRecord | null | undefined)[],
): number {
  return records.filter(isCapEligible).length;
}

/**
 * Whether the owner of `ownedRecords` may create another workspace.
 *
 * `used` can exceed `cap` — three free workspaces plus a lapsed Pro is four
 * owned free workspaces. Nothing is deleted, disabled, or reclaimed in that
 * case; the user simply cannot create another until they are back under the
 * cap. This is a creation gate, and only that.
 */
export function resolveWorkspaceCreateQuota(
  ownedRecords: readonly (WorkspaceCapRecord | null | undefined)[],
): WorkspaceCreateQuota {
  const used = countCapEligibleWorkspaces(ownedRecords);
  return { used, cap: MAX_SELF_SERVE_WORKSPACES, allowed: used < MAX_SELF_SERVE_WORKSPACES };
}

/**
 * The note shown where creation would otherwise be offered. Reads the cap
 * actually in force rather than hardcoding "3", and names the upgrade path,
 * which is the one action that frees a slot.
 */
export function workspaceCapMessage(cap: number): string {
  const workspaces = `${cap} workspace${cap === 1 ? "" : "s"}`;
  return `Free accounts include ${workspaces}. Upgrade one to Pro to create another.`;
}
