import { Hono } from "hono";
import { getWorkspaceUsage } from "../usage";
import { requireScope, type WorkspaceVars } from "../workspace";

/** Read-only workspace usage snapshot. Auth + `files:read`. */
export const usage = new Hono<WorkspaceVars>().get("/", requireScope("files:read"), async (c) =>
  c.json(await getWorkspaceUsage(c.env.DB, c.get("workspaceName"))),
);
