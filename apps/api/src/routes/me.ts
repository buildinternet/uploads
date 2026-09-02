/**
 * Session-authenticated, read-only usage surface for signed-in users (issue
 * #107 — follow-on to /admin-ui/*'s Phase 3 pattern). Gated by
 * `requireSessionUser` only — NOT `requireAdminUser` — so any signed-in user
 * can see their own workspace memberships and usage, not just admins.
 *
 * Authorization for `/workspaces/:name/usage` is the membership lookup
 * itself: a workspace not present in the caller's own memberships 404s
 * (`workspace_not_found`) rather than 403ing, so membership can't be probed
 * for workspace existence any more precisely than for any other workspace.
 */
import { resolveWorkspaceCreateQuota } from "@uploads/billing";
import { NotFoundError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { badKey } from "../files-core";
import {
  membershipsForUser,
  myWorkspaceFromMembership,
  workspacesFromMembership,
  type MyWorkspace,
} from "../org-workspaces";
import { presetResolvedSessionUser } from "../dual-workspace-auth";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { loadWorkspaceRecord } from "../workspace";
import { planResponse } from "../workspace-plan";
import { workspaceFiles } from "./workspace-files";
import { workspaceGalleries } from "./workspace-galleries";
import { workspaceGithub } from "./workspace-github";
import { workspaceMembers } from "./workspace-members";
import { workspaceSettings } from "./workspace-settings";
import { workspaceUsage } from "./workspace-usage";
import { workspaces } from "./workspaces";

/**
 * Rewrites `c`'s request onto `router`'s own path space and re-dispatches
 * through it directly, so the canonical dual-auth middleware + handler run
 * exactly as they would for a caller hitting the canonical route directly —
 * response shape can't drift from the canonical route without the alias
 * breaking too. `path` must already have every interpolated segment
 * `encodeURIComponent`-encoded by the caller (see the `forwardToWorkspace*`
 * wrappers below): an unencoded `/` or `..` in a param would let `URL`
 * normalize dot segments and reshape which route this actually dispatches
 * to (CodeRabbit PR #617 review finding 2).
 *
 * Shared by every `forwardToWorkspace*` wrapper below — they differ only in
 * which canonical router they re-dispatch through.
 */
async function forwardTo(
  router: { fetch: typeof workspaceFiles.fetch },
  c: Context<SessionVars>,
  path: string,
): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  // `c.executionCtx` throws outside a real Workers/`app.fetch(req, env, ctx)`
  // invocation (e.g. the `app().request(path, init, env)` helper most route
  // tests use, including this file's) — same guard as the welcome-email
  // `waitUntil` above.
  let executionCtx: Context<SessionVars>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const forwarded = new Request(url, c.req.raw);
  // This router's own `sessionAuth` middleware already resolved the caller
  // (see the `.use("/*", sessionAuth, requireSessionUser)` mount below) —
  // hand that off so `dualWorkspaceAuth` skips a second `get-session` fetch
  // for the same request (issue #613 phase 1 follow-up).
  presetResolvedSessionUser(forwarded, requireUserId(c));
  return router.fetch(forwarded, c.env, executionCtx);
}

/**
 * Forwards to the canonical files vertical (`routes/workspace-files.ts`,
 * issue #613 phase 1) — routes registered as `/:workspace/files*`.
 */
function forwardToWorkspaceFiles(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceFiles, c, path);
}

/**
 * Forwards to the canonical dual-auth galleries vertical
 * (`routes/workspace-galleries.ts`, issue #613 final phase) — routes
 * registered as `/:workspace/galleries*`. Its `GET /:workspace/galleries`
 * list is now enriched with `itemCount`/`references` for every caller (see
 * that router's `listGalleriesEnrichedHandler`), matching this route's old
 * inline shape exactly — so this is now a genuine forward, not a
 * reimplementation.
 */
function forwardToWorkspaceGalleries(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceGalleries, c, path);
}

/**
 * Forwards to the canonical dual-auth github vertical
 * (`routes/workspace-github.ts`, issue #613 final phase) — routes registered
 * as `/:workspace/github/*`. The canonical `titles`/`status`/`repo-links`
 * handlers are session-member/admin-gated (a bearer 403s
 * `github_requires_session`/`github_repo_links_requires_session`), moved
 * verbatim from this file's original bodies, so this is a genuine forward.
 */
function forwardToWorkspaceGithub(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceGithub, c, path);
}

/**
 * Forwards to the canonical usage vertical (`routes/workspace-usage.ts`,
 * issue #613 phase 2). Response shape is a strict superset of the pre-#613
 * session shape (adds `scopes`/`plan`; every other field —
 * `workspace`/`bytes`/`objects`/`uploadsInPeriod`/`periodStart`/limits —
 * matches verbatim), so this is a genuine forward, not a re-implementation.
 */
function forwardToWorkspaceUsage(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceUsage, c, path);
}

/**
 * Forwards to the canonical invites/members vertical
 * (`routes/workspace-members.ts`, issue #613 phase 3) for the session-only
 * routes (`members`/`people`/`invites` GET/DELETE/`members/:id` PATCH). The
 * canonical handlers are the exact bodies this file's routes used to run
 * (extracted verbatim, see git history), so this is a genuine forward.
 */
function forwardToWorkspaceMembers(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceMembers, c, path);
}

/**
 * Forwards `POST /workspaces/:name/invites` to `routes/workspaces.ts`'s
 * `POST /:name/invites` — the ONE invites/members route with a genuine
 * bearer capability, upgraded in place to `dualGovernanceAuth` rather than
 * duplicated into `workspace-members.ts` (see that route's docblock). Same
 * response shape as this file's pre-#613 handler (both built `{ ...payload,
 * acceptUrl }` from the same AUTH `/internal/invite` call), so this is a
 * genuine forward, not a reimplementation.
 */
function forwardToWorkspaceInvite(c: Context<SessionVars>, name: string): Promise<Response> {
  return forwardTo(workspaces, c, `/${encodeURIComponent(name)}/invites`);
}

/**
 * Forwards to the canonical comment-settings/storage/billing/summary
 * verticals (`routes/workspace-settings.ts`, issue #613 phase 3). The
 * canonical handlers are the exact bodies these four routes used to run in
 * this file (extracted verbatim, see git history), so this is a genuine
 * forward, not a reimplementation.
 */
function forwardToWorkspaceSettings(c: Context<SessionVars>, path: string): Promise<Response> {
  return forwardTo(workspaceSettings, c, path);
}

/**
 * Every workspace the user's memberships map to. Memberships already include
 * org id/slug/name from AUTH, so this is one service call — not N org
 * lookups. Workspace names come from `workspacesFromMembership` (today 1:1).
 */
async function myWorkspaces(env: Env, userId: string): Promise<MyWorkspace[]> {
  const memberships = await membershipsForUser(env, userId);
  const out: MyWorkspace[] = [];
  for (const membership of memberships) {
    for (const workspace of workspacesFromMembership(membership)) {
      out.push(myWorkspaceFromMembership(membership, workspace));
    }
  }
  return out;
}

function requireUserId(c: Context<SessionVars>): string {
  // requireSessionUser guarantees a session user; the guard is belt-and-braces
  // and keeps the 404 (not 401) shape uniform with the not-a-member case.
  const userId = c.get("sessionUser")?.id;
  if (!userId) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  return userId;
}

export const me = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser)

  // Workspaces the caller belongs to, via their org memberships. `hasPublicUrl`
  // lets the account UI decide, per workspace, whether opening a file should
  // navigate to the public /f/ page (issue #135) or resolve through the
  // signed-URL-capable /file-url endpoint (issue #123) — see
  // apps/web's WorkspaceFileTable. `plan` (issue #365 follow-up, purely
  // additive) is the same catalog-id string `planResponse` returns for the
  // billing tab — "free" whenever the record has no plan applied (getPlan's
  // fail-open-to-free contract), so a legacy/unapplied record can never read
  // as "pro" here either. Lets the nav/list surfaces show a small Pro badge
  // without a per-workspace billing round trip. Both fields are loaded here
  // (not in `myWorkspaces`, which every member-gated route calls for
  // authorization) so the extra KV read per workspace stays confined to this
  // one listing endpoint.
  .get("/workspaces", async (c) => {
    const userId = c.get("sessionUser")?.id;
    if (!userId) throw new NotFoundError("no session user", { code: "workspace_not_found" });
    const workspaces = await myWorkspaces(c.env, userId);
    const loaded = await Promise.all(
      workspaces.map(async (ws) => {
        const record = await loadWorkspaceRecord(c.env, ws.workspace);
        const publicBaseUrl = record?.publicBaseUrl;
        const plan = record ? planResponse(ws.workspace, record).plan : "free";
        // `hasPublicUrl` kept alongside the URL itself for existing consumers.
        return {
          record,
          entry: Object.assign({}, ws, {
            hasPublicUrl: Boolean(publicBaseUrl),
            publicBaseUrl,
            plan,
          }),
        };
      }),
    );
    // Creation quota (spec 2026-07-24) so the account UI can stop offering a
    // create affordance the API would refuse. Free rider on the records this
    // handler already loaded — no extra KV reads. Advisory only: `POST
    // /v1/workspaces` remains the enforcement point.
    const quota = resolveWorkspaceCreateQuota(
      loaded.filter(({ entry }) => entry.role === "owner").map(({ record }) => record),
    );
    return c.json({ workspaces: loaded.map(({ entry }) => entry), workspaceCreate: quota });
  })

  // Usage + limits for one workspace — 404s unless the caller is a member.
  // Issue #613 phase 2: forwards to the canonical dual-auth handler in
  // `routes/workspace-usage.ts` — its response is a strict superset of this
  // route's old shape (adds `scopes`/`plan`), so this is a genuine forward
  // (see `forwardToWorkspaceUsage`'s docblock), not a reimplementation.
  .get("/workspaces/:name/usage", (c) =>
    forwardToWorkspaceUsage(c, `/${encodeURIComponent(c.req.param("name"))}/usage`),
  )

  // Workspace shell for the account rail: membership + public URL + usage.
  // Issue #613 phase 3: forwards to the canonical dual-auth-free (session-
  // only) handler in `routes/workspace-settings.ts` — the extracted handler
  // is byte-for-byte the body this route used to run, so response shape
  // can't drift. See `forwardToWorkspaceSettings`'s docblock.
  .get("/workspaces/:name/summary", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/summary`),
  )

  // Plan metadata, resolved effective limits, usage, and subscription state
  // for the account billing tab. Same forward as above. `stripeCustomerId`
  // redaction preserved exactly in the canonical handler — see its docblock.
  .get("/workspaces/:name/billing", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/billing`),
  )

  // People in one workspace — member-gated (teammate fields only, not admin
  // raw rows). Issue #613 phase 3: forwards to the canonical dual-auth-free
  // (session-only) handler in `routes/workspace-members.ts` — the extracted
  // handler is byte-for-byte the body this route used to run, so response
  // shape can't drift. See `forwardToWorkspaceMembers`'s docblock.
  .get("/workspaces/:name/members", (c) =>
    forwardToWorkspaceMembers(c, `/${encodeURIComponent(c.req.param("name"))}/members`),
  )

  // People tab: members + (for admins) pending invites + role in one authz
  // pass. Same forward as above.
  .get("/workspaces/:name/people", (c) =>
    forwardToWorkspaceMembers(c, `/${encodeURIComponent(c.req.param("name"))}/people`),
  )

  // Galleries in one workspace — member-gated. Issue #613 final phase: the
  // canonical `/v1/workspaces/:workspace/galleries` list is now enriched
  // with `itemCount`/`references` per gallery for every caller (see
  // `workspace-galleries.ts`'s `listGalleriesEnrichedHandler`), so this
  // route forwards there instead of reimplementing. The pre-#613 shape had
  // no `limit`/`cursor`/`nextCursor` — the canonical route defaults `limit`
  // to 50 (same default this handler used) and adds `nextCursor`, an
  // additive field this response shape tolerates the same way
  // `apps/web/src/lib/api-client.ts`'s `GallerySummary` already marks
  // `itemCount`/`references` optional.
  .get("/workspaces/:name/galleries", (c) =>
    forwardToWorkspaceGalleries(c, `/${encodeURIComponent(c.req.param("name"))}/galleries`),
  )

  // Issue #613 phase 1: list/search/facets/by-path/file-url/visibility/delete
  // now forward to the canonical dual-auth handlers in
  // `routes/workspace-files.ts` (mounted at `/v1/workspaces/:workspace/files*`)
  // via a path rewrite — `forwardToWorkspaceFiles` re-dispatches through that
  // router directly, so response shape is unchanged: the canonical handlers
  // were ported verbatim from this file's original implementations (removed
  // here, see git history). `DELETE` additionally rewrites its query-param
  // `?key=` onto the canonical route's path segment — the one
  // behavior-preserving exception, since the canonical DELETE is path-keyed
  // (a wart fix carried over from the token-authed surface, which already
  // worked this way).
  .get("/workspaces/:name/files", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files`),
  )
  .get("/workspaces/:name/files/search", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files/search`),
  )
  .get("/workspaces/:name/files/facets", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files/facets`),
  )
  .get("/workspaces/:name/files/by-path", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files/by-path`),
  )
  .get("/workspaces/:name/file-url", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files/file-url`),
  )
  .patch("/workspaces/:name/files/visibility", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/files/visibility`),
  )
  .delete("/workspaces/:name/files", (c) => {
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();
    const keyPath = key.split("/").map(encodeURIComponent).join("/");
    return forwardToWorkspaceFiles(
      c,
      `/${encodeURIComponent(c.req.param("name"))}/files/${keyPath}`,
    );
  })

  // files-sdk's folder-aware browser gateway. Issue #613 final phase:
  // forwards to the canonical session-member-gated handler in
  // `routes/workspace-files.ts` — the extracted handler is byte-for-byte the
  // body this route used to run, so response shape can't drift. See
  // `forwardToWorkspaceFiles`'s docblock.
  .all("/workspaces/:name/file-browser", (c) =>
    forwardToWorkspaceFiles(c, `/${encodeURIComponent(c.req.param("name"))}/file-browser`),
  )

  // Invite an email to the org backing this workspace (Better Auth invitation).
  // Workspace org admin|owner only. Returns acceptUrl so self-hosted installs
  // without Email Sending can still hand the invitee a link. Issue #613
  // phase 3: forwards to `routes/workspaces.ts`'s canonical
  // `POST /:name/invites` (now `dualGovernanceAuth`-guarded) — see
  // `forwardToWorkspaceInvite`'s docblock for why this route, uniquely among
  // this vertical's session routes, forwards to `workspaces.ts` rather than
  // `workspace-members.ts`.
  .post("/workspaces/:name/invites", (c) => forwardToWorkspaceInvite(c, c.req.param("name")))

  // Pending invites for this workspace — admin/owner only (they can revoke).
  // Issue #613 phase 3: forwards to the canonical session-only handler in
  // `routes/workspace-members.ts`.
  .get("/workspaces/:name/invites", (c) =>
    forwardToWorkspaceMembers(c, `/${encodeURIComponent(c.req.param("name"))}/invites`),
  )

  // Revoke a pending invite — admin/owner only. Same forward as above. Each
  // param is `encodeURIComponent`-ed before interpolation: `c.req.param`
  // returns the URL-decoded segment, so a raw `/` or `..` here could
  // otherwise reshape the forwarded pathname and dispatch against a
  // different route than the one this URL named (CodeRabbit PR #617 review
  // finding 2 — hygiene/correctness, not an auth bypass, since
  // `sessionAdminGate` re-resolves membership on whatever workspace the
  // rewritten request actually names).
  .delete("/workspaces/:name/invites/:id", (c) =>
    forwardToWorkspaceMembers(
      c,
      `/${encodeURIComponent(c.req.param("name"))}/invites/${encodeURIComponent(c.req.param("id"))}`,
    ),
  )

  // Remove a member (by opaque member id) — admin/owner only; matrix
  // enforced in auth worker. Same forward pattern, same per-segment encoding.
  .delete("/workspaces/:name/members/:memberId", (c) =>
    forwardToWorkspaceMembers(
      c,
      `/${encodeURIComponent(c.req.param("name"))}/members/${encodeURIComponent(c.req.param("memberId"))}`,
    ),
  )

  // Change a member's role (admin↔member); auth worker enforces the matrix.
  // Same forward pattern, same per-segment encoding.
  .patch("/workspaces/:name/members/:memberId", (c) =>
    forwardToWorkspaceMembers(
      c,
      `/${encodeURIComponent(c.req.param("name"))}/members/${encodeURIComponent(c.req.param("memberId"))}`,
    ),
  )

  // Batch PR/issue titles for the connected-work rail (issue #267). Member-
  // gated: title text for private repos is sensitive, and membership scoping
  // keeps this from becoming a public title oracle for whatever repos the
  // App can read. Per-ref failures are nulls — the endpoint never fails the
  // batch wholesale. Issue #613 final phase: forwards to the canonical
  // session-member-gated handler in `routes/workspace-github.ts` — the
  // extracted handler is byte-for-byte the body this route used to run, so
  // response shape can't drift. See `forwardToWorkspaceGithub`'s docblock.
  .get("/workspaces/:name/github-titles", (c) =>
    forwardToWorkspaceGithub(c, `/${encodeURIComponent(c.req.param("name"))}/github/titles`),
  )

  // Whether this workspace already has the GitHub App installed (issue #492),
  // so the rail's `install github app` CTA can stop nagging workspaces that
  // installed it. Member-gated like the sibling `/github-titles`: the answer
  // is derived from the workspace's repo bindings, which aren't public.
  // Never fails — see `githubInstallStatus` for the degrade-to-false rule.
  // Same forward as above.
  .get("/workspaces/:name/github-status", (c) =>
    forwardToWorkspaceGithub(c, `/${encodeURIComponent(c.req.param("name"))}/github/status`),
  )

  // Repos this workspace has linked (issue #307, Task 7) — feeds the comment
  // settings preview panel's repo picker. Admin/owner-gated like the
  // comment-settings/preview routes below (same audience: whoever can edit
  // the defaults is whoever should see which repos they apply to). This is
  // the session-authed counterpart to admin-ui's operator-only
  // `/admin-ui/workspaces/:name/github-links` — that route needs
  // `ADMIN_TOKEN`, which the web app's Better Auth session can't produce.
  // Repo names only: the web client has no use for installationId/source/
  // createdAt, and trimming them keeps this from becoming a second surface
  // to keep in sync with `repoLinkResponse` in admin-ui.ts. Issue #613 final
  // phase: forwards to the canonical session-admin-gated handler in
  // `routes/workspace-github.ts`, which keeps this exact `{repos}`
  // projection. Same forward pattern as above.
  .get("/workspaces/:name/repo-links", (c) =>
    forwardToWorkspaceGithub(c, `/${encodeURIComponent(c.req.param("name"))}/github/repo-links`),
  )

  // Workspace-level managed-comment defaults (issue #307): image width,
  // inline-image cap, the two legacy booleans, and a short note. Admin/owner
  // only — these are workspace-wide defaults every repo comment inherits
  // unless a repo's `.uploads.yml` overrides them. Issue #613 phase 3:
  // forwards to the canonical handler in `routes/workspace-settings.ts` —
  // the extracted handler is byte-for-byte the body this route used to run.
  .get("/workspaces/:name/comment-settings", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/comment-settings`),
  )

  // Patch the defaults above. Same forward as above.
  .patch("/workspaces/:name/comment-settings", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/comment-settings`),
  )

  // Preview the production managed-comment body against resolved comment
  // settings (issue #307). Admin/owner-gated like the settings routes above.
  // Issue #613 final phase: forwards to the canonical session-admin-gated
  // handler in `routes/workspace-settings.ts` — the extracted handler is
  // byte-for-byte the body this route used to run, so response shape can't
  // drift. See that router's `commentPreviewHandler` docblock.
  .get("/workspaces/:name/comment-preview", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/comment-preview`),
  )

  // Self-serve BYO R2 bucket (issue #583 Task 1.1): read/verify/write/detach
  // of a workspace's storage config. Same audience as the comment-settings
  // triple above (admin/owner only). Issue #613 phase 3: forwards to the
  // canonical handlers in `routes/workspace-settings.ts` — extracted
  // byte-for-byte from the bodies these four routes used to run, so
  // response shape (masked `storageStatusResponse` projection, never
  // credential values) can't drift.
  .get("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage`),
  )
  .post("/workspaces/:name/storage/verify", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage/verify`),
  )
  .post("/workspaces/:name/storage/buckets", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage/buckets`),
  )
  .put("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage`),
  )
  .post("/workspaces/:name/storage/activate", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage/activate`),
  )
  .delete("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${encodeURIComponent(c.req.param("name"))}/storage`),
  )
  // SVG/XML active-content lane check (issue #929) — same forward posture as
  // the five routes above; the web settings page's "Check now" button calls
  // this alias the same way it calls activate.
  .post("/workspaces/:name/storage/lanes/:laneId/verify-active-content", (c) =>
    forwardToWorkspaceSettings(
      c,
      `/${encodeURIComponent(c.req.param("name"))}/storage/lanes/${encodeURIComponent(c.req.param("laneId"))}/verify-active-content`,
    ),
  );
