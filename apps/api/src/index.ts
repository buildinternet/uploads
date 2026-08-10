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
import { workspaceFiles } from "./routes/workspace-files";
import { workspaceGalleries } from "./routes/workspace-galleries";
import { workspaceUsage } from "./routes/workspace-usage";
import { workspaceGithub } from "./routes/workspace-github";
import { workspaceMembers } from "./routes/workspace-members";
import { workspaceSettings } from "./routes/workspace-settings";
import { me } from "./routes/me";
import { runRetentionSweep } from "./retention-sweep";
import { runObservabilityRetention } from "./observability-retention";
import { galleries } from "./routes/galleries";
import { publicGalleries } from "./routes/public-galleries";
import { publicFiles } from "./routes/public-files";
import { publicGithubAvatars } from "./routes/public-github-avatars";
import { telemetry } from "./routes/telemetry";
import { reports } from "./routes/reports";
import { abuse } from "./routes/abuse";
import { render } from "./routes/render";
import { githubWebhook } from "./routes/github-webhook";
import { handleGithubWebhookBatch } from "./github-webhook-queue";
import { githubComment } from "./routes/github-comment";
import { githubPromote } from "./routes/github-promote";
import { githubLink } from "./routes/github-link";
import { githubHealth } from "./routes/github-health";
import { githubActivity } from "./routes/github-activity";
import { internalBilling } from "./routes/internal-billing";
import { protectedResourceMetadata, requestOrigin } from "./well-known";
import { ROBOTS_TXT } from "./robots";

/** Loopback origins are trusted only outside production — mirrors
 *  apps/auth/src/trusted-origins.ts. */
function devOriginAllowed(origin: string, env: { ENVIRONMENT?: string }): boolean {
  if (env.ENVIRONMENT === "production") return false;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// Lets the browser console on the web origin (and local dev) call the token-
// authenticated endpoints. CORS is not the security boundary — bearer tokens
// are — but without these headers the preflight for Authorization fails.
const consoleCors = cors({
  origin: (origin, c) => {
    if (origin === (c.env.WEB_ORIGIN || "https://uploads.sh")) return origin;
    if (devOriginAllowed(origin, c.env)) return origin;
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
    if (devOriginAllowed(origin, c.env)) return origin;
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
  .get("/robots.txt", (c) =>
    c.text(ROBOTS_TXT, 200, {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "text/plain; charset=utf-8",
    }),
  )
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
  // Public GitHub owner avatar proxy (file byline + connected-work rail).
  // Edge-cached image bytes; unauthenticated. See github-avatars.ts.
  .route("/public/github/avatars", publicGithubAvatars)
  // Session-authenticated workspace-token mint (Phase 4). Registered BEFORE the
  // `/v1/:workspace/*` bearer guard: `/v1/tokens` does NOT match that pattern
  // (no trailing segment), so `workspaceAuth` never runs for it — this route
  // brings its own session auth. See routes/tokens.ts.
  .route("/v1/tokens", tokens)
  .route("/v1/workspaces", workspaces)
  // Canonical dual-auth files vertical (issue #613 phase 1):
  // `/v1/workspaces/:workspace/files*`, session cookie OR bearer token. Same
  // `/v1/workspaces` mount prefix as the lifecycle router above, distinct
  // sub-router — same "same base path, distinct sub-app" pattern already
  // used five times below for `/v1/:workspace/github`. Brings its own auth
  // (`dualWorkspaceAuth`, applied per-route inside workspace-files.ts), so
  // it does not sit behind the `workspaceAuth` guard further down.
  .route("/v1/workspaces", workspaceFiles)
  // Canonical dual-auth galleries + usage verticals (issue #613 phase 2):
  // `/v1/workspaces/:workspace/galleries*` and `/v1/workspaces/:workspace/usage*`.
  // Same "self-contained sub-router, own auth + error boundary" shape as
  // `workspaceFiles` above.
  .route("/v1/workspaces", workspaceGalleries)
  .route("/v1/workspaces", workspaceUsage)
  // Canonical dual-auth github vertical (issue #613 phase 3):
  // `/v1/workspaces/:workspace/github/*`, collapsing the five sub-routers
  // mounted separately below into one router. Same "self-contained
  // sub-router, own auth + error boundary" shape as `workspaceFiles` above.
  .route("/v1/workspaces", workspaceGithub)
  // Canonical invites/members vertical (issue #613 phase 3):
  // `/v1/workspaces/:workspace/members`, `/people`, `/invites*`,
  // `/members/:memberId*` — session-only (a bearer 403s
  // `members_requires_session`; see `routes/workspace-members.ts`'s
  // docblock for why this vertical mints no new bearer capability). The one
  // route in this vertical with a real bearer capability,
  // `POST /:name/invites`, is NOT here — it was upgraded in place inside
  // `workspaces` above (now `dualGovernanceAuth`-guarded) rather than
  // parallel-registered, to avoid a same-path double-registration/shadowing
  // hazard with the pre-existing governance-token route.
  .route("/v1/workspaces", workspaceMembers)
  // Canonical comment-settings, storage, and billing/summary verticals
  // (issue #613 phase 3): `/v1/workspaces/:workspace/comment-settings`,
  // `/storage`, `/storage/verify`, `/summary`, `/billing` — session-only,
  // two privilege tiers (member for summary/billing, admin/owner for
  // comment-settings/storage). A bearer 403s `billing_requires_session` or
  // `settings_requires_session` depending on the tier; see
  // `routes/workspace-settings.ts`'s docblock. No new bearer capability
  // minted for any route here, same posture as `workspaceMembers` above.
  .route("/v1/workspaces", workspaceSettings)
  // Anonymous CLI/MCP usage pings — no auth, before workspace guard.
  .route("/v1/telemetry", telemetry)
  // Explicit opt-in diagnostic reports (message + optional log) — no auth.
  .route("/v1/reports", reports)
  // Public content / abuse reports from the file page — no auth; emails abuse@.
  .route("/v1/abuse", abuse)
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
  // Issue #338: recent-PRs-with-media feed, same base path, distinct
  // sub-route "/activity".
  .route("/v1/:workspace/github", githubActivity)
  // Internal plan-set route (Stripe phase 2, task 3): secret-gated via the
  // `x-internal-billing-key` header, not session/bearer auth, so it's outside
  // /v1 and the workspaceAuth guard entirely — same "brings its own auth"
  // treatment as /v1/github/webhook above. See routes/internal-billing.ts.
  .route("/internal/billing", internalBilling)
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
      runObservabilityRetention(env).catch((err) => {
        const appErr = AppError.from(err);
        console.error(
          JSON.stringify({
            message: "observability_retention_failed",
            error: appErr.message,
            code: appErr.code,
          }),
        );
      }),
    );
  },
};
