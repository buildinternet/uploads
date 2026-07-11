import { AppError, NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { respondError } from "./error-response";
import { workspaceAuth, type WorkspaceVars } from "./workspace";
import { files } from "./routes/files";
import { usage } from "./routes/usage";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { runRetentionSweep } from "./retention-sweep";

/** Hono app — also re-exported for vitest (`app.request`). */
export const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/admin", admin)
  .route("/auth", auth)
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/files", files)
  .route("/v1/:workspace/usage", usage)
  .onError((err, c) => respondError(c, err))
  .notFound((c) => respondError(c, new NotFoundError()));

/** Worker entry: fetch + daily retention cron. */
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runRetentionSweep(env).catch((err) => {
        const appErr = AppError.from(err);
        console.error(
          JSON.stringify({
            message: "retention_sweep_failed",
            error: appErr.message,
            code: appErr.code,
          }),
        );
      }),
    );
  },
};
