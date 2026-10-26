/** Public viewer reads only. Keep generation and authenticated routes out of this entrypoint. */
import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { respondError } from "./error-response";
import { requestDbSession } from "./request-db-session";
import { publicFiles } from "./routes/public-files";
import { publicFeeds } from "./routes/public-feeds";
import { publicGalleries } from "./routes/public-galleries";
import type { WorkspaceVars } from "./workspace";

export const app = new Hono<WorkspaceVars>()
  .use("*", requestDbSession)
  .get("/health", (c) => c.json({ ok: true }))
  .route("/public/files", publicFiles)
  .route("/public/feeds", publicFeeds)
  .route("/public/galleries", publicGalleries)
  .onError((err, c) => respondError(c, err))
  .notFound((c) => respondError(c, new NotFoundError()));

export default { fetch: app.fetch.bind(app) };
