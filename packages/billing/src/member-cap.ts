/**
 * Member-cap resolution for a workspace (issue #450). Pure — no I/O — so
 * apps/api's internal cap route and any future surface (admin panel, plan
 * tab) share one answer to "how many members may this workspace have".
 *
 * Deliberately NOT `resolveEffectiveLimits`. That seam treats an absent
 * `plan` as legacy/unlimited, which is right for upload budgets: those
 * records predate billing and were provisioned unlimited on purpose. But
 * `plan` is only ever written by Stripe (`/internal/billing/plan`) or an
 * operator (`PATCH /admin-ui/workspaces/:name/plan`) — self-serve
 * provisioning writes free's numeric limits and no `plan` field at all — so
 * a member cap keyed on `plan === "free"` alone would bind to almost no
 * real workspace. `selfServe` is the honest signal for "this is a free
 * tenant that simply never had a plan stamped on it".
 */
import { getPlan } from "./plans";

/** The shape `resolveMemberCap` needs from a workspace record — a subset of
 * apps/api's `WorkspaceRecord`, restated here so this package keeps its
 * independence from `@uploads/api`. */
export interface MemberCapRecord {
  /** Subscription plan, when one has been stamped. */
  plan?: string;
  /** True for workspaces provisioned by the self-serve flow. */
  selfServe?: boolean;
  /** Per-workspace override: a number caps, `null` clears to unlimited. */
  maxMembers?: number | null;
}

/**
 * Effective member cap, or `null` for unlimited.
 *
 * Precedence:
 * 1. An explicit `maxMembers` on the record always wins — a positive number
 *    caps, `null` (or a non-positive/non-finite value) means unlimited. This
 *    is how an operator comps an exception from the admin panel.
 * 2. Otherwise the plan default applies, but only to workspaces the cap is
 *    meant for: those explicitly on a plan, or self-serve workspaces with no
 *    plan stamped (treated as free).
 * 3. Otherwise unlimited — legacy operator-provisioned workspaces (no plan,
 *    not self-serve) keep the unlimited posture they have in production
 *    today.
 */
export function resolveMemberCap(record: MemberCapRecord): number | null {
  const override = record.maxMembers;
  if (override === null) return null;
  if (override !== undefined) {
    return Number.isFinite(override) && override > 0 ? override : null;
  }

  const planned = record.plan !== undefined || record.selfServe === true;
  if (!planned) return null;

  // getPlan fails open to `free` for an unrecognized/absent plan string,
  // which is exactly what a self-serve record with no plan should resolve to.
  const cap = getPlan(record.plan).defaultLimits.maxMembers;
  return typeof cap === "number" && cap > 0 ? cap : null;
}

/**
 * The denial message shown at the invite point. Honest about the number
 * actually in force (a comped override reads as its own number, not "3"),
 * and only nudges toward Pro when Pro would in fact raise the cap — a
 * workspace already on pro, or one with a comped override, gets a plain
 * statement instead of an upsell it can't act on.
 */
export function memberCapMessage(cap: number, record: MemberCapRecord): string {
  const members = `${cap} member${cap === 1 ? "" : "s"}`;
  const onFree = record.maxMembers === undefined && getPlan(record.plan).id === "free";
  return onFree
    ? `Free workspaces include ${members} — upgrade to Pro for more.`
    : `This workspace includes ${members}.`;
}
