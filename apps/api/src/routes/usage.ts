import { Hono } from "hono";
import { usageWithLimits } from "../budget";
import { getWorkspaceUsage } from "../usage";
import { requireScope, type WorkspaceVars } from "../workspace";

/** Read-only workspace usage (+ configured limits when set). Auth + `files:read`. */
export const usage = new Hono<WorkspaceVars>().get("/", requireScope("files:read"), async (c) => {
  const snapshot = await getWorkspaceUsage(c.env.DB, c.get("workspaceName"));
  return c.json(usageWithLimits(snapshot, c.get("workspace")));
});
