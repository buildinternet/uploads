import { NotFoundError, ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { createFeed, getFeed, listFeeds, softDeleteFeed } from "../feeds";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedSummary,
  hydrateOwnerFeed,
  unwrapFeedMutation,
} from "../feed-service";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";
import { dbFor } from "../db-session";
import { boundedDataRead } from "../data-read-bounds";

async function ownerFeed(c: Context<WorkspaceVars>, id: string) {
  const record = await getFeed(dbFor(c.env), c.get("workspaceName"), id);
  if (!record) throw new NotFoundError("Feed not found.", { code: "feed_not_found" });
  return hydrateOwnerFeed(c.env, c.get("workspace"), record);
}

export async function createFeedHandler(c: Context<WorkspaceVars>) {
  const body = await jsonBody(c);
  const result = unwrapFeedMutation(
    await createFeed(dbFor(c.env), {
      workspace: c.get("workspaceName"),
      repo: typeof body.repo === "string" ? body.repo : "",
      path: body.path === null || typeof body.path === "string" ? body.path : undefined,
    }),
  );
  const feed = await ownerFeed(c, result.value.id);
  return c.json(feed, result.created ? 201 : 200);
}

export async function listFeedsHandler(c: Context<WorkspaceVars>) {
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("limit must be an integer from 1 to 100.");
  const page = await boundedDataRead(
    c,
    () =>
      listFeeds(dbFor(c.env), c.get("workspaceName"), {
        limit,
        cursor: decodeFeedCursor(c.req.query("cursor")),
      }),
    { name: "d1_feeds_list" },
  );
  return c.json({
    feeds: page.feeds.map((feed) => feedSummary(c.env, feed)),
    nextCursor: page.nextCursor ? encodeFeedCursor(page.nextCursor) : null,
  });
}

export async function getFeedHandler(c: Context<WorkspaceVars>) {
  return c.json(await ownerFeed(c, c.req.param("id") as string));
}

export async function deleteFeedHandler(c: Context<WorkspaceVars>) {
  const result = unwrapFeedMutation(
    await softDeleteFeed(dbFor(c.env), c.get("workspaceName"), c.req.param("id") as string),
  );
  return c.json({ deleted: true, id: result.value.id });
}

/** Bearer-only legacy-shaped router. Canonical dual-auth lives in workspace-feeds.ts. */
export const feeds = new Hono<WorkspaceVars>()
  .post("/", writeRateLimit, requireScope("files:write"), createFeedHandler)
  .get("/", requireScope("files:read"), listFeedsHandler)
  .get("/:id", requireScope("files:read"), getFeedHandler)
  .delete("/:id", writeRateLimit, requireScope("files:write"), deleteFeedHandler);
