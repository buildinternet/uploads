import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { resolvePublicFeed } from "../feeds";
import { hydratePublicFeed, publicFeedItemPage } from "../feed-service";
import { decodeScopeCursor } from "../pr-scope";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
import { dbFor } from "../db-session";

function feedNotFound(): NotFoundError {
  return new NotFoundError("Feed not found.", { code: "feed_not_found" });
}

async function liveFeed(env: Env, id: string) {
  const record = await resolvePublicFeed(dbFor(env), id);
  if (!record) throw feedNotFound();
  const workspace = await loadWorkspaceRecord(env, record.workspace);
  if (!workspace) throw feedNotFound();
  return { record, workspace };
}

export const publicFeeds = new Hono<WorkspaceVars>()
  .get("/:id", async (c) => {
    const { record, workspace } = await liveFeed(c.env, c.req.param("id"));
    const cursor = decodeScopeCursor(c.req.query("cursor"));
    return c.json(await hydratePublicFeed(c.env, workspace, record, { cursor }));
  })
  // Pager item plus neighbours, found by a scope scan (cap 2,000) so items
  // older than the first page still resolve.
  .get("/:id/items/:item", async (c) => {
    const { record, workspace } = await liveFeed(c.env, c.req.param("id"));
    const page = await publicFeedItemPage(c.env, workspace, record, c.req.param("item"));
    if (!page) throw new NotFoundError("Feed item not found.", { code: "feed_item_not_found" });
    return c.json(page);
  });
