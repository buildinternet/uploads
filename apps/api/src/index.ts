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
import { tokens } from "./routes/tokens";
import { workspaces } from "./routes/workspaces";
import { me } from "./routes/me";
import { runRetentionSweep } from "./retention-sweep";
import { runStagingReaper } from "./staging-reaper";
import { galleries } from "./routes/galleries";
import { publicGalleries } from "./routes/public-galleries";
import { publicFiles } from "./routes/public-files";
import { telemetry } from "./routes/telemetry";
import { reports } from "./routes/reports";
import { render } from "./routes/render";
import { githubWebhook } from "./routes/github-webhook";
import { handleGithubWebhookBatch } from "./github-webhook-queue";
import { githubComment } from "./routes/github-comment";
import { githubPromote } from "./routes/github-promote";
import { githubLink } from "./routes/github-link";
import { githubHealth } from "./routes/github-health";
import { protectedResourceMetadata, requestOrigin } from "./well-known";

// Lets the browser console on the web origin (and local dev) call the token-
// authenticated endpoints. CORS is not the security boundary — bearer tokens
// are — but without these headers the preflight for Authorization fails.
const consoleCors = cors({
  origin: (origin, c) => {
    if (origin === (c.env.WEB_ORIGIN || "https://uploads.sh")) return origin;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null;
  },
  // PATCH is used by browser console clients for file metadata + galleries.
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
});

// /admin-ui/* and /me/* are both session-cookie-authenticated (see
// src/session-auth.ts — requireAdminUser for /admin-ui, requireSessionUser
// only for /me), so unlike consoleCors above they must be credentialed —
// same treatment as apps/auth's authCors for the web origin's cross-origin
// browser calls (uploads.sh -> api.uploads.sh). The `/admin/*` surface is
// bearer-token-only and deliberately untouched by CORS credentials — it
// accepts either the static ADMIN_TOKEN break-glass secret or a D1-backed
// operator token minted via POST /v1/tokens with an admin:* scope (#257).
const adminUiCors = cors({
  origin: (origin, c) => {
    if (origin === (c.env.WEB_ORIGIN || "https://uploads.sh")) return origin;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null;
  },
  credentials: true,
  // PATCH: admin workspace limits, OAuth client edits, /me member role +
  // file-visibility updates. Omitting it fails the browser preflight with
  // "Method PATCH is not allowed by Access-Control-Allow-Methods".
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  maxAge: 86400,
});

/** Hono app — also re-exported for vitest (`app.request`). */
export const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  // RFC 9728 discovery: this API is an OAuth resource server (workspace bearer
  // tokens with `files:*` scopes). Public, uncached-cross-origin so browser
  // agents can read it. See src/well-known.ts.
  .get("/.well-known/oauth-protected-resource", (c) =>
    c.json(
      protectedResourceMetadata({
        resource: requestOrigin(c.req.url),
        resourceName: "uploads.sh REST API",
        webOrigin: c.env.WEB_ORIGIN || "https://uploads.sh",
      }),
      200,
      { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
    ),
  )
  .use("/admin/*", consoleCors)
  .use("/admin-ui/*", adminUiCors)
  .use("/me/*", adminUiCors)
  // `/v1/workspaces` (and its `/:name` / `/:name/restore` lifecycle
  // subroutes from #249) is the one `/v1/*` surface authenticated by session
  // COOKIE, so its CORS must be credentialed like /me/* — the uncredentialed
  // consoleCors preflight makes the browser drop the request entirely
  // ("Failed to fetch"), which silently broke self-serve workspace creation
  // from uploads.sh. Everything else under /v1/* stays uncredentialed:
  // bearer tokens are the boundary there.
  .use("/v1/*", (c, next) =>
    (c.req.path === "/v1/workspaces" || c.req.path.startsWith("/v1/workspaces/")
      ? adminUiCors
      : consoleCors)(c, next),
  )
  .route("/admin", admin)
  .route("/admin-ui", adminUi)
  .route("/me", me)
  .route("/auth", auth)
  .route("/public/galleries", publicGalleries)
  // Public single-object metadata for the file page (#135). Like public
  // galleries, fetched server-side by apps/web; no CORS (not a browser call).
  .route("/public/files", publicFiles)
  // Session-authenticated workspace-token mint (Phase 4). Registered BEFORE the
  // `/v1/:workspace/*` bearer guard: `/v1/tokens` does NOT match that pattern
  // (no trailing segment), so `workspaceAuth` never runs for it — this route
  // brings its own session auth. See routes/tokens.ts.
  .route("/v1/tokens", tokens)
  .route("/v1/workspaces", workspaces)
  // Anonymous CLI/MCP usage pings — no auth, before workspace guard.
  .route("/v1/telemetry", telemetry)
  // Explicit opt-in diagnostic reports (message + optional log) — no auth.
  .route("/v1/reports", reports)
  // Screenshot render (phase 1, POST /v1/render). Brings its own auth
  // (tokenWorkspaceAuth resolves the workspace from the token, not the path)
  // so — like /v1/tokens — it must be registered before the `/v1/:workspace/*`
  // guard: that pattern requires a trailing segment and never matches this
  // route. See src/routes/render.ts.
  .route("/v1/render", render)
  // GitHub App webhooks (phase 2 PR A). HMAC-verified, no session/bearer auth.
  // MUST stay before the `/v1/:workspace/*` guard below: that pattern matches
  // this path, so registration order is what keeps workspaceAuth from running.
  .route("/v1/github/webhook", githubWebhook)
  .use("/v1/:workspace/*", workspaceAuth)
  .route("/v1/:workspace/galleries", galleries)
  .route("/v1/:workspace/files", files)
  .route("/v1/:workspace/usage", usage)
  // Bot-owned managed comment (phase 2 PR B). Workspace-authed (unlike the
  // HMAC-public /v1/github/webhook above) — behind the workspaceAuth guard.
  .route("/v1/:workspace/github", githubComment)
  // Phase 2a: promotes branch-staged attachments into a PR's attachment
  // prefix. Same base path as the comment route above (workspace-authed,
  // distinct sub-route "/promote" vs "/comment").
  .route("/v1/:workspace/github", githubPromote)
  // Phase 4b: explicit claim/inspect for the workspace<->repo binding (see
  // github-repo-links.ts) — same base path, distinct sub-route "/link".
  .route("/v1/:workspace/github", githubLink)
  // Issue #293 follow-up: App-level webhook event subscription check, same
  // base path, distinct sub-route "/health".
  .route("/v1/:workspace/github", githubHealth)
  .onError((err, c) => respondError(c, err))
  .notFound((c) => respondError(c, new NotFoundError()));

/** Worker entry: fetch + daily retention cron + GitHub webhook queue consumer. */
export default {
  fetch: app.fetch.bind(app),
  // GitHub webhook ingestion queue + its DLQ (issue #287); see
  // github-webhook-queue.ts. Batch handling never throws.
  queue: handleGithubWebhookBatch,
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
    ctx.waitUntil(
      runStagingReaper(env).catch((err) => {
        const appErr = AppError.from(err);
        console.error(
          JSON.stringify({
            message: "staging_reap_failed",
            error: appErr.message,
            code: appErr.code,
          }),
        );
      }),
    );
  },
};
