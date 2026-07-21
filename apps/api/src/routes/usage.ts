import { Hono } from "hono";
import { usageWithLimits } from "../budget";
import { reconcileWorkspaceUsage } from "../reconcile";
import { purgeExpiredObjects } from "../retention";
import { getWorkspaceUsage } from "../usage";
import { requireScope, type WorkspaceVars } from "../workspace";

/**
 * Usage snapshot + maintenance:
 * - GET  /           read counters (+ limits)
 * - POST /reconcile  rebuild bytes/objects from storage
 * - POST /purge-expired  delete past retentionDays, then reconcile
 */
export const usage = new Hono<WorkspaceVars>()
  .get("/", requireScope("files:read"), async (c) => {
    const snapshot = await getWorkspaceUsage(c.env.DB, c.get("workspaceName"));
    // `scopes` reflects the presented credential, not the workspace — doctor
    // uses it to surface a token that can't delete before the user hits a
    // surprise `forbidden`. Legacy tokens report the full file-scope set,
    // which is what they actually have.
    return c.json({
      ...usageWithLimits(snapshot, c.get("workspace")),
      scopes: c.get("authScopes"),
    });
  })

  .post("/reconcile", requireScope("files:write"), async (c) => {
    const result = await reconcileWorkspaceUsage(c.env, c.get("workspace"), c.get("workspaceName"));
    return c.json({
      ...result,
      usage: usageWithLimits(result.usage, c.get("workspace")),
    });
  })

  .post("/purge-expired", requireScope("files:delete"), async (c) => {
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
  });
