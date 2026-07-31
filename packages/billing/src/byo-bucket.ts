/**
 * Plan-capability predicate for the self-serve BYO-bucket surface (issue
 * #583 Task 1.3). Pure — no I/O — sibling to `workspace-cap.ts` and
 * `member-cap.ts`.
 *
 * Ships dark: `PLANS.*.byoBucket` is `true` for every plan today, and
 * nothing calls this predicate for enforcement yet. The live gate is the
 * per-workspace `byoBucketEnabled` record flag
 * (`apps/api/src/workspace.ts`'s `byoBucketAllowed`), off by default and
 * operator-set only. This predicate exists so that when a future billing
 * decision restricts BYO to a paid plan, that's a one-line flip on
 * `PLANS` plus wiring this predicate into the gate check — not new
 * plumbing. Callers read this predicate, never switch on plan id
 * (precedent: `marketsMemberCap`).
 */
import { getPlan } from "./plans";

/** The shape the predicate needs from a workspace record — a subset of
 * apps/api's `WorkspaceRecord`, restated here so this package keeps its
 * independence from `@uploads/api`. */
export interface ByoBucketPlanRecord {
  /** Subscription plan, when one has been stamped. */
  plan?: string;
}

/**
 * Whether this workspace's plan permits the BYO-bucket surface. Currently
 * always `true` (every plan's `byoBucket` capability is `true`) — the real
 * gate today is `byoBucketAllowed` in `apps/api/src/workspace.ts`, not this
 * predicate. `getPlan` fails open to `free` for an unrecognized/absent plan
 * string, same as every other plan-capability read in this package.
 */
export function planAllowsByoBucket(record: ByoBucketPlanRecord): boolean {
  return getPlan(record.plan).byoBucket;
}
