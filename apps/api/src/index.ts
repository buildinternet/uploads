import { AppError, NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { respondError } from "./error-response";
import { workspaceAuth, type WorkspaceVars } from "./workspace";
import { files } from "./routes/files";
import { usage } from "./routes/usage";
import { admin } from "./routes/admin";
import { adminUi } from "./routes/admin-ui";
import { auth } from "./routes/auth";
import { runRetentionSweep } from "./retention-sweep";
import { galleries } from "./routes/galleries";
import { publicGalleries } from "./routes/public-galleries";

// Lets the browser console on the web origin (and local dev) call the token-
// authenticated endpoints. CORS is not the security boundary — bearer tokens
// are — but without these headers the preflight for Authorization fails.
const consoleCors = cors({
  origin: (origin, c) => {
    if (origin === (c.env.WEB_ORIGIN || "https://uploads.sh")) return origin;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null;
  },
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
});

// /admin-ui/* is session-cookie-authenticated (requireAdminUser, see
// src/session-auth.ts), so unlike consoleCors above it must be credentialed
// — same treatment as apps/auth's authCors for the web origin's cross-origin
// browser calls (uploads.sh -> api.uploads.sh). The ADMIN_TOKEN-gated
// `/admin/*` surface is bearer-token-only and deliberately untouched.
const adminUiCors = cors({
  origin: (origin, c) => {
    if (origin === (c.env.WEB_ORIGIN || "https://uploads.sh")) return origin;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null;
  },
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  maxAge: 86400,
});

/** Hono app — also re-exported for vitest (`app.request`). */
export const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  .use("/admin/*", consoleCors)
  .use("/admin-ui/*", adminUiCors)
  .use("/v1/*", consoleCors)
  .route("/admin", admin)
  .route("/admin-ui", adminUi)
  .route("/auth", auth)
  .route("/public/galleries", publicGalleries)
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/galleries", galleries)
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
