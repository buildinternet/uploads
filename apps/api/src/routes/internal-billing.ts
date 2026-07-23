/**
 * Internal plan-set route (Stripe phase 2, task 3): `POST /internal/billing/plan`.
 * Not session/bearer authed like the rest of the API — a shared secret in the
 * `x-internal-billing-key` header, checked timing-safe against
 * `env.BILLING_INTERNAL_KEY` the same way `adminAuth` compares `ADMIN_TOKEN`
 * (see admin.ts): hash both sides with sha256Hex and compare the hashes with
 * `crypto.subtle.timingSafeEqual` so the raw secret is never compared
 * directly and unequal-length inputs don't leak via `timingSafeEqual`'s
 * length check. Fail-closed: an unset `BILLING_INTERNAL_KEY` always 401s,
 * regardless of what header is sent — this route must be dormant until a
 * secret is deliberately configured (see wrangler.jsonc).
 *
 * Body: `{ workspace: string, plan: "free" | "pro" }`. `plan` reuses
 * `PLAN_IDS`/`PlanId` from `@uploads/billing`, the same source of truth as
 * the admin panel's `PATCH /admin-ui/workspaces/:name/plan` (workspace-plan.ts).
 * Only `plan` is written — `mutateWorkspaceRecord` read-modify-writes the
 * whole record, so limit overrides, tokens, etc. are preserved untouched.
 *
 * `BILLING_INTERNAL_KEY` is read through an intersection type rather than
 * `Env` directly: it must be added to `worker-configuration.d.ts` (via
 * `wrangler types`, which reads `.dev.vars`) for the ambient `Env` interface
 * to carry it, and that's a local/per-deploy secret file this change
 * deliberately doesn't touch — see the `.dev.vars.example` entry and the
 * comment in wrangler.jsonc for how to provision it.
 */
import { PLAN_IDS, type PlanId } from "@uploads/billing";
import { UnauthorizedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { jsonBody } from "./json-body";
import { hexToBytes, sha256Hex } from "../workspace";
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

internalBilling.post("/plan", async (c) => {
  const env = c.env as Env & { BILLING_INTERNAL_KEY?: string };
  const secret = env.BILLING_INTERNAL_KEY ?? "";
  const provided = c.req.header("x-internal-billing-key") ?? "";

  const providedHash = await sha256Hex(provided);
  const expectedHash = secret ? await sha256Hex(secret) : providedHash.replace(/./g, "0");
  const ok =
    secret.length > 0 &&
    provided.length > 0 &&
    crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));
  if (!ok) throw new UnauthorizedError();

  const body = await jsonBody(c);
  const { workspace, plan } = validatePlanSetBody(body);

  // mutateWorkspaceRecord throws NotFoundError for an unknown or
  // non-serving (soft-deleted) workspace — propagates to respondError as 404.
  await mutateWorkspaceRecord(c.env, workspace, (record) => ({ ...record, plan }), {
    requireServing: true,
  });

  return c.body(null, 204);
});
