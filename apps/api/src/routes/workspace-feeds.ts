/**
 * Canonical feeds vertical: `/:workspace/feeds*`, mounted at `/v1/workspaces`
 * so public paths are `/v1/workspaces/:workspace/feeds*`. Dual-auth
 * (`dualWorkspaceAuth`) — session cookie or bearer token.
 *
 * Handler bodies are shared with the bearer router in `routes/feeds.ts`.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { dualWorkspaceAuth, type DualAuthVars } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { writeRateLimit } from "../guards";
import { requireScope } from "../workspace";
import { createFeedHandler, deleteFeedHandler, getFeedHandler, listFeedsHandler } from "./feeds";

function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}
const rateLimited = writeRateLimit as unknown as MiddlewareHandler<DualAuthVars>;

export const workspaceFeeds = new Hono<DualAuthVars>()
  .post(
    "/:workspace/feeds",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    createFeedHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/feeds",
    dualWorkspaceAuth(),
    scoped("files:read"),
    listFeedsHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/feeds/:id",
    dualWorkspaceAuth(),
    scoped("files:read"),
    getFeedHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .delete(
    "/:workspace/feeds/:id",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    deleteFeedHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .onError((err, c) => respondError(c, err));
