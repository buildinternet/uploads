/**
 * Internal billing routes reached over a service binding, never from the
 * public internet:
 *
 * - `POST /internal/billing/plan` (Stripe phase 2, task 3) — the auth
 *   worker's Stripe webhook bridge sets a workspace's plan.
 * - `GET /internal/billing/member-cap` (issue #450) — the auth worker asks
 *   how many members a workspace may have before creating an invitation.
 *   Members live in the auth worker's D1 and the plan lives in this
 *   worker's KV, so the count happens there and the cap is resolved here.
 *
 * Neither is session/bearer authed like the rest of the API — a shared secret in the
 * `x-internal-billing-key` header, checked timing-safe against
 * `env.BILLING_INTERNAL_KEY` the same way `adminAuth` compares `ADMIN_TOKEN`
 * (see admin.ts): hash both sides with sha256Hex and compare the hashes with
 * `crypto.subtle.timingSafeEqual` so the raw secret is never compared
 * directly and unequal-length inputs don't leak via `timingSafeEqual`'s
 * length check. Fail-closed: an unset `BILLING_INTERNAL_KEY` always 401s,
 * regardless of what header is sent — this route must be dormant until a
 * secret is deliberately configured (see wrangler.jsonc).
 *
 * The plan route's body is `{ workspace: string, plan: "free" | "pro" }`. `plan` reuses
 * `PLAN_IDS`/`PlanId` from `@uploads/billing`, the same source of truth as
 * the admin panel's `PATCH /admin-ui/workspaces/:name/plan` (workspace-plan.ts).
 * Only `plan` is written — `mutateWorkspaceRecord` read-modify-writes the
 * whole record, so limit overrides, tokens, etc. are preserved untouched.
 *
 * `BILLING_INTERNAL_KEY` is declared optional on `Env` in `src/env.d.ts`
 * alongside the other `wrangler secret put` secrets — not left to the
 * generated `worker-configuration.d.ts`, which is git-ignored and regenerated
 * in CI without `.dev.vars`. See the `.dev.vars.example` entry and the comment
 * in wrangler.jsonc for how to provision it.
 */
import { memberCapMessage, PLAN_IDS, resolveMemberCap, type PlanId } from "@uploads/billing";
import { UnauthorizedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import type { Context } from "hono";
import { jsonBody } from "./json-body";
import { hexToBytes, loadWorkspaceRecord, sha256Hex } from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import type { WorkspaceVars } from "../workspace";

export const internalBilling = new Hono<WorkspaceVars>();

function validatePlanSetBody(body: Record<string, unknown>): { workspace: string; plan: PlanId } {
  const { workspace, plan } = body;
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new ValidationError("workspace is required", { code: "invalid_workspace" });
  }
  if (typeof plan !== "string" || !PLAN_IDS.includes(plan as PlanId)) {
    throw new ValidationError(`plan must be one of: ${PLAN_IDS.join(", ")}`, {
      code: "invalid_plan",
    });
  }
  return { workspace, plan: plan as PlanId };
}

/**
 * Shared-secret gate for every route in this module. Extracted so the
 * member-cap route can't drift from the plan route's fail-closed compare
 * (an unset `BILLING_INTERNAL_KEY` always 401s, whatever header is sent).
 */
async function requireInternalKey(c: Context<WorkspaceVars>): Promise<void> {
  const secret = c.env.BILLING_INTERNAL_KEY ?? "";
  const provided = c.req.header("x-internal-billing-key") ?? "";

  const providedHash = await sha256Hex(provided);
  const expectedHash = secret ? await sha256Hex(secret) : providedHash.replace(/./g, "0");
  const ok =
    secret.length > 0 &&
    provided.length > 0 &&
    crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));
  if (!ok) throw new UnauthorizedError();
}

internalBilling.post("/plan", async (c) => {
  await requireInternalKey(c);

  const body = await jsonBody(c);
  const { workspace, plan } = validatePlanSetBody(body);

  // mutateWorkspaceRecord throws NotFoundError for an unknown or
  // non-serving (soft-deleted) workspace — propagates to respondError as 404.
  await mutateWorkspaceRecord(c.env, workspace, (record) => ({ ...record, plan }), {
    requireServing: true,
  });

  return c.body(null, 204);
});

/**
 * The communal `default` workspace is exempt from the member cap, the same
 * way it's already exempt from the other member flows (see slug-policy.ts).
 * Today it also resolves to unlimited on its own — it's operator-provisioned,
 * so it has neither a `plan` nor `selfServe` — but naming it here means an
 * operator stamping a plan on it can't accidentally cap the shared workspace.
 */
const MEMBER_CAP_EXEMPT_WORKSPACES = new Set(["default"]);

/**
 * `GET /internal/billing/member-cap?workspace=<name>` — the cap the auth
 * worker enforces at invite creation (issue #450).
 *
 * Responds `{ workspace, cap, message }` where `cap` is a positive integer
 * or `null` for unlimited, and `message` is the denial copy to show at the
 * invite point (built here because only this worker knows whether the
 * workspace is on free and can honestly nudge toward Pro).
 *
 * An unknown or soft-deleted workspace resolves to `null` rather than 404:
 * this route answers "what cap should the invite path enforce", and the
 * absence of a workspace record is not a reason to block an invite to an org
 * that exists. The auth worker fails open on a non-ok response anyway.
 */
internalBilling.get("/member-cap", async (c) => {
  await requireInternalKey(c);

  const workspace = c.req.query("workspace") ?? "";
  if (!workspace) {
    throw new ValidationError("workspace is required", { code: "invalid_workspace" });
  }

  const record = MEMBER_CAP_EXEMPT_WORKSPACES.has(workspace)
    ? null
    : await loadWorkspaceRecord(c.env, workspace);
  const cap = record ? resolveMemberCap(record) : null;

  return c.json({
    workspace,
    cap,
    message: cap === null || !record ? null : memberCapMessage(cap, record),
  });
});
