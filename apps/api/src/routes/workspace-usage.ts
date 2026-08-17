/**
 * Canonical usage vertical (issue #613 phase 2): `/:workspace/usage*`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/usage*`. Dual-auth (`dualWorkspaceAuth`) for the
 * read snapshot; the two maintenance ops (`reconcile`, `purge-expired`) are
 * deliberately bearer-token-only even on this canonical surface — see the
 * `authSource === "token"` guard below.
 */
import { getPlan } from "@uploads/billing";
import { ForbiddenError } from "@uploads/errors";
import { Hono, type MiddlewareHandler } from "hono";
import { usageWithLimits } from "../budget";
import { dualWorkspaceAuth, type DualAuthVars } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { reconcileWorkspaceUsage } from "../reconcile";
import { purgeExpiredObjects } from "../retention";
import { getWorkspaceUsage } from "../usage";
import { requireScope } from "../workspace";

function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}

/**
 * `reconcile`/`purge-expired` are maintenance ops with deliberately no
 * session equivalent (see `.context/613-api-consolidation-plan.md`, "usage"
 * section): a session caller who is a workspace member has already cleared
 * `dualWorkspaceAuth`'s membership check, so refusing them here is a 403
 * ("not allowed to do this"), not a 404 ("this doesn't exist") — membership
 * was already proven, existence was never in question.
 */
const requireToken: MiddlewareHandler<DualAuthVars> = async (c, next) => {
  // `authSource` is `"d1" | "legacy" | "session" | "api-key"` (see `workspace.ts` /
  // `dual-workspace-auth.ts`) — the two bearer-token varieties vs. a session
  // cookie. Only a session caller is rejected here.
  if (c.get("authSource") === "session") {
    throw new ForbiddenError("requires an API token", { code: "usage_requires_token" });
  }
  await next();
};

export const workspaceUsage = new Hono<DualAuthVars>()
  .get("/:workspace/usage", dualWorkspaceAuth(), scoped("files:read"), async (c) => {
    const snapshot = await getWorkspaceUsage(c.env.DB, c.get("workspaceName"));
    const workspace = c.get("workspace");
    // `scopes` reflects the presented credential — for a session caller this
    // is the `FILE_SCOPES` set `dualWorkspaceAuth` grants (matching the
    // bearer route's own "legacy tokens report the full file-scope set"
    // note). `plan` is the catalog id (free|pro).
    return c.json({
      ...usageWithLimits(snapshot, workspace),
      scopes: c.get("authScopes"),
      plan: getPlan(workspace.plan).id,
    });
  })
  .post(
    "/:workspace/usage/reconcile",
    dualWorkspaceAuth(),
    scoped("files:write"),
    requireToken,
    async (c) => {
      const result = await reconcileWorkspaceUsage(
        c.env,
        c.get("workspace"),
        c.get("workspaceName"),
      );
      return c.json({
        ...result,
        usage: usageWithLimits(result.usage, c.get("workspace")),
      });
    },
  )
  .post(
    "/:workspace/usage/purge-expired",
    dualWorkspaceAuth(),
    scoped("files:delete"),
    requireToken,
    async (c) => {
      const result = await purgeExpiredObjects(c.env, c.get("workspace"), c.get("workspaceName"));
      if ("skipped" in result) {
        return c.json(result, 200);
      }
      return c.json({
        ...result,
        reconcile: {
          ...result.reconcile,
          usage: usageWithLimits(result.reconcile.usage, c.get("workspace")),
        },
      });
    },
  )
  .onError((err, c) => respondError(c, err));
