import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { resolvePublicFeed } from "../feeds";
import { hydratePublicFeed } from "../feed-service";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
import { dbFor } from "../db-session";

export const publicFeeds = new Hono<WorkspaceVars>().get("/:id", async (c) => {
  const record = await resolvePublicFeed(dbFor(c.env), c.req.param("id"));
  if (!record) throw new NotFoundError("Feed not found.", { code: "feed_not_found" });
  const workspace = await loadWorkspaceRecord(c.env, record.workspace);
  if (!workspace) {
    throw new NotFoundError("Feed not found.", { code: "feed_not_found" });
  }
  return c.json(await hydratePublicFeed(c.env, workspace, record));
});
