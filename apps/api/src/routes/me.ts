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
import {
  resolveCommentOptions,
  type OptionSource,
  type ResolvedCommentOptions,
} from "@uploads/comment-config";
import { NotFoundError, ValidationError } from "@uploads/errors";
import { createFilesRouter } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { parseExternalReference } from "../external-references";
import { previewFixtureItems } from "../comment-preview-fixtures";
import { badKey, listObjects } from "../files-core";
import { listGalleries } from "../galleries";
import { galleryListSummaries } from "../gallery-service";
import {
  attachmentsCommentBody,
  attachmentsMarker,
  type AttachmentItem,
} from "../github-comment-render";
import { githubInstallStatus, type GithubInstallStatus } from "../github-install-status";
import { findRepoLink, listRepoLinksForWorkspace } from "../github-repo-links";
import { resolveRepoCommentOptions, workspaceCommentDefaults } from "../repo-comment-config";
import { resolveTitles } from "../github-titles";
import {
  adminWorkspaceOr403,
  memberWorkspaceOr404,
  membershipsForUser,
  myWorkspaceFromMembership,
  workspacesFromMembership,
  type MyWorkspace,
} from "../org-workspaces";
import { presetResolvedSessionUser } from "../dual-workspace-auth";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { storage } from "../storage";
import { loadWorkspaceRecord } from "../workspace";
import { planResponse } from "../workspace-plan";
import { workspaceFiles } from "./workspace-files";
import { workspaceMembers } from "./workspace-members";
import { workspaceSettings } from "./workspace-settings";
import { workspaceUsage } from "./workspace-usage";
import { workspaces } from "./workspaces";

/**
 * Rewrites `c`'s request onto `workspaceFiles`'s own path space (its routes
 * are registered as `/:workspace/files*`, independent of any parent mount —
 * see routes/workspace-files.ts) and re-dispatches through it directly. The
 * canonical dual-auth middleware + handler run exactly as they would for a
 * caller hitting `/v1/workspaces/:workspace/files*` directly, so response
 * shape can't drift from the canonical route without this alias breaking too.
 */
async function forwardToWorkspaceFiles(c: Context<SessionVars>, path: string): Promise<Response> {
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
  return workspaceFiles.fetch(forwarded, c.env, executionCtx);
}

/**
 * Same forwarding pattern as `forwardToWorkspaceFiles`, targeting the
 * canonical usage vertical (`routes/workspace-usage.ts`, issue #613 phase 2).
 * Response shape is a strict superset of the pre-#613 session shape (adds
 * `scopes`/`plan`; every other field — `workspace`/`bytes`/`objects`/
 * `uploadsInPeriod`/`periodStart`/limits — matches verbatim), so this is a
 * genuine forward, not a re-implementation.
 */
async function forwardToWorkspaceUsage(c: Context<SessionVars>, path: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  let executionCtx: Context<SessionVars>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const forwarded = new Request(url, c.req.raw);
  presetResolvedSessionUser(forwarded, requireUserId(c));
  return workspaceUsage.fetch(forwarded, c.env, executionCtx);
}

/**
 * Same forwarding pattern, targeting the canonical invites/members vertical
 * (`routes/workspace-members.ts`, issue #613 phase 3) for the session-only
 * routes (`members`/`people`/`invites` GET/DELETE/`members/:id` PATCH). The
 * canonical handlers are the exact bodies this file's routes used to run
 * (extracted verbatim, see git history), so this is a genuine forward.
 */
async function forwardToWorkspaceMembers(c: Context<SessionVars>, path: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  let executionCtx: Context<SessionVars>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const forwarded = new Request(url, c.req.raw);
  presetResolvedSessionUser(forwarded, requireUserId(c));
  return workspaceMembers.fetch(forwarded, c.env, executionCtx);
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
async function forwardToWorkspaceInvite(c: Context<SessionVars>, name: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = `/${name}/invites`;
  let executionCtx: Context<SessionVars>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const forwarded = new Request(url, c.req.raw);
  presetResolvedSessionUser(forwarded, requireUserId(c));
  return workspaces.fetch(forwarded, c.env, executionCtx);
}

/**
 * Same forwarding pattern, targeting the canonical comment-settings/storage/
 * billing/summary verticals (`routes/workspace-settings.ts`, issue #613
 * phase 3). The canonical handlers are the exact bodies these four routes
 * used to run in this file (extracted verbatim, see git history), so this
 * is a genuine forward, not a reimplementation.
 */
async function forwardToWorkspaceSettings(
  c: Context<SessionVars>,
  path: string,
): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  let executionCtx: Context<SessionVars>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const forwarded = new Request(url, c.req.raw);
  presetResolvedSessionUser(forwarded, requireUserId(c));
  return workspaceSettings.fetch(forwarded, c.env, executionCtx);
}

/** `?repo=` shape for the comment preview endpoint: exactly one `/`, no empty segments. */
const REPO_SHAPE_RE = /^[^/\s]+\/[^/\s]+$/;

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
  // apps/web's AccountFileBrowser. `plan` (issue #365 follow-up, purely
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
    forwardToWorkspaceUsage(c, `/${c.req.param("name")}/usage`),
  )

  // Workspace shell for the account rail: membership + public URL + usage.
  // Issue #613 phase 3: forwards to the canonical dual-auth-free (session-
  // only) handler in `routes/workspace-settings.ts` — the extracted handler
  // is byte-for-byte the body this route used to run, so response shape
  // can't drift. See `forwardToWorkspaceSettings`'s docblock.
  .get("/workspaces/:name/summary", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/summary`),
  )

  // Plan metadata, resolved effective limits, usage, and subscription state
  // for the account billing tab. Same forward as above. `stripeCustomerId`
  // redaction preserved exactly in the canonical handler — see its docblock.
  .get("/workspaces/:name/billing", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/billing`),
  )

  // People in one workspace — member-gated (teammate fields only, not admin
  // raw rows). Issue #613 phase 3: forwards to the canonical dual-auth-free
  // (session-only) handler in `routes/workspace-members.ts` — the extracted
  // handler is byte-for-byte the body this route used to run, so response
  // shape can't drift. See `forwardToWorkspaceMembers`'s docblock.
  .get("/workspaces/:name/members", (c) =>
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/members`),
  )

  // People tab: members + (for admins) pending invites + role in one authz
  // pass. Same forward as above.
  .get("/workspaces/:name/people", (c) =>
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/people`),
  )

  // Galleries in one workspace — member-gated. Issue #613 phase 2: NOT
  // forwarded to the canonical `/v1/workspaces/:workspace/galleries` list —
  // this session shape carries `itemCount`/`references` per gallery (from
  // `galleryListSummaries`) that the canonical/bearer list route omits (it
  // uses the cheaper `gallerySummary` projection instead), so canonical is
  // not a strict superset. `apps/web/src/lib/api-client.ts`'s `GallerySummary`
  // does mark both fields optional ("Omitted on older API deployments"), but
  // per the conservative rule for this migration (keep-and-document over
  // inventing a new shape), this handler stays as-is rather than either
  // dropping those fields for everyone or growing the canonical route to add
  // them just for this alias. See `.context/613-api-consolidation-plan.md`.
  .get("/workspaces/:name/galleries", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const page = await listGalleries(c.env.DB, name, { limit: 50 });
    return c.json({
      galleries: await galleryListSummaries(c.env, name, page.galleries),
    });
  })

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
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files`),
  )
  .get("/workspaces/:name/files/search", (c) =>
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/search`),
  )
  .get("/workspaces/:name/files/facets", (c) =>
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/facets`),
  )
  .get("/workspaces/:name/files/by-path", (c) =>
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/by-path`),
  )
  .get("/workspaces/:name/file-url", (c) =>
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/file-url`),
  )
  .patch("/workspaces/:name/files/visibility", (c) =>
    forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/visibility`),
  )
  .delete("/workspaces/:name/files", (c) => {
    const key = c.req.query("key") ?? "";
    if (badKey(key)) throw new NotFoundError();
    const keyPath = key.split("/").map(encodeURIComponent).join("/");
    return forwardToWorkspaceFiles(c, `/${c.req.param("name")}/files/${keyPath}`);
  })

  // files-sdk's folder-aware browser gateway. Authorization happens before a
  // storage instance is constructed; readonly plus this operation allow-list
  // independently prevent member UI requests from mutating storage.
  .all("/workspaces/:name/file-browser", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const router = createFilesRouter({
      files: (await storage(c.env, record)).readonly(),
      operations: ["list"],
      maxListLimit: 100,
      // files-sdk resolves a signing secret even when signing operations are
      // disabled. This value is intentionally non-secret and cannot authorize
      // anything on this list-only, authenticated gateway.
      secret: `readonly-list:${name}`,
    });
    return router.handle(c.req.raw);
  })

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
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/invites`),
  )

  // Revoke a pending invite — admin/owner only. Same forward as above.
  .delete("/workspaces/:name/invites/:id", (c) =>
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/invites/${c.req.param("id")}`),
  )

  // Remove a member (by opaque member id) — admin/owner only; matrix
  // enforced in auth worker. Same forward pattern.
  .delete("/workspaces/:name/members/:memberId", (c) =>
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/members/${c.req.param("memberId")}`),
  )

  // Change a member's role (admin↔member); auth worker enforces the matrix.
  // Same forward pattern.
  .patch("/workspaces/:name/members/:memberId", (c) =>
    forwardToWorkspaceMembers(c, `/${c.req.param("name")}/members/${c.req.param("memberId")}`),
  )

  // Batch PR/issue titles for the connected-work rail (issue #267). Member-
  // gated: title text for private repos is sensitive, and membership scoping
  // keeps this from becoming a public title oracle for whatever repos the
  // App can read. Per-ref failures are nulls — the endpoint never fails the
  // batch wholesale.
  .get("/workspaces/:name/github-titles", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const raw = (c.req.query("refs") ?? "").split(",").filter((s) => s.length > 0);
    if (raw.length === 0) {
      throw new ValidationError("refs query parameter required", { code: "refs_required" });
    }
    if (raw.length > 20) {
      throw new ValidationError("at most 20 refs per request", { code: "too_many_refs" });
    }
    const normalized = raw.map((coordinate) => {
      const parsed = parseExternalReference("github", coordinate);
      if (!parsed.ok) {
        throw new ValidationError(`invalid ref: ${coordinate}`, { code: "invalid_ref" });
      }
      // normalizedKey carries a `github:item:` provider prefix — the gh.ref
      // metadata shape (and this response's keys) is bare
      // `owner/repo#number`, so derive it from the locator instead.
      const { owner, repository, number } = parsed.value.locator;
      return `${owner}/${repository}#${number}`;
    });

    const titles = await resolveTitles(c.env, [...new Set(normalized)]);
    return c.json({ refs: titles });
  })

  // Whether this workspace already has the GitHub App installed (issue #492),
  // so the rail's `install github app` CTA can stop nagging workspaces that
  // installed it. Member-gated like the sibling `/github-titles`: the answer
  // is derived from the workspace's repo bindings, which aren't public.
  // Never fails — see `githubInstallStatus` for the degrade-to-false rule.
  .get("/workspaces/:name/github-status", async (c) => {
    const name = c.req.param("name");
    await memberWorkspaceOr404(c.env, requireUserId(c), name);
    return c.json<GithubInstallStatus>(await githubInstallStatus(c.env, name));
  })

  // Repos this workspace has linked (issue #307, Task 7) — feeds the comment
  // settings preview panel's repo picker. Admin/owner-gated like the
  // comment-settings/preview routes below (same audience: whoever can edit
  // the defaults is whoever should see which repos they apply to). This is
  // the session-authed counterpart to admin-ui's operator-only
  // `/admin-ui/workspaces/:name/github-links` — that route needs
  // `ADMIN_TOKEN`, which the web app's Better Auth session can't produce.
  // Repo names only: the web client has no use for installationId/source/
  // createdAt, and trimming them keeps this from becoming a second surface
  // to keep in sync with `repoLinkResponse` in admin-ui.ts.
  .get("/workspaces/:name/repo-links", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const links = await listRepoLinksForWorkspace(c.env.DB, name);
    return c.json({ repos: links.map((link) => link.repo) });
  })

  // Workspace-level managed-comment defaults (issue #307): image width,
  // inline-image cap, the two legacy booleans, and a short note. Admin/owner
  // only — these are workspace-wide defaults every repo comment inherits
  // unless a repo's `.uploads.yml` overrides them. Issue #613 phase 3:
  // forwards to the canonical handler in `routes/workspace-settings.ts` —
  // the extracted handler is byte-for-byte the body this route used to run.
  .get("/workspaces/:name/comment-settings", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/comment-settings`),
  )

  // Patch the defaults above. Same forward as above.
  .patch("/workspaces/:name/comment-settings", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/comment-settings`),
  )

  // Preview the production managed-comment body against resolved comment
  // settings (issue #307). Admin/owner-gated like the settings routes above:
  // the response includes per-key source attribution ("repo" | "workspace" |
  // "auto"), which a plain member has no reason to see. With no `repo` query
  // param, resolution runs against workspace defaults only (`repoConfig:
  // null`) via the same `resolveCommentOptions(null, ...)` entrypoint
  // `resolveRepoCommentOptions` wraps. With `repo`, it must already be
  // linked to THIS workspace (github-repo-links.ts) — otherwise 404, so a
  // preview can't be used to probe another workspace's repo binding or
  // `.uploads.yml` contents.
  //
  // Renders from a page of the workspace's own `gh/`-prefixed attachments
  // (first page only, mirrors gatherAttachments's url/pageUrl mapping but
  // skips the D1 metadata read — the preview needs no per-item meta beyond
  // what the static fixtures already carry). `listObjects` pages in
  // lexicographic key order, not upload recency, so this is a representative
  // sample rather than the "most recent" uploads. An empty workspace falls
  // back to `previewFixtureItems` so the preview is never blank.
  .get("/workspaces/:name/comment-preview", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

    const repo = c.req.query("repo");
    let resolved: ResolvedCommentOptions;
    let source: Record<keyof ResolvedCommentOptions, OptionSource>;
    let repoConfig: { found: boolean; path: string | null; warnings: string[] } | null = null;

    if (repo !== undefined) {
      if (!REPO_SHAPE_RE.test(repo)) {
        throw new ValidationError("repo must be in owner/name form", { code: "invalid_repo" });
      }
      const link = await findRepoLink(c.env.DB, repo);
      if (!link || link.workspaceName !== name) {
        throw new NotFoundError("repo not linked to this workspace", { code: "repo_not_linked" });
      }
      const resolvedRepo = await resolveRepoCommentOptions(c.env, record, repo);
      resolved = resolvedRepo.options;
      source = resolvedRepo.source;
      repoConfig = {
        found: resolvedRepo.fetch.found,
        path: resolvedRepo.fetch.path,
        warnings: resolvedRepo.fetch.warnings,
      };
    } else {
      const resolvedDefaults = resolveCommentOptions(null, workspaceCommentDefaults(record));
      resolved = resolvedDefaults.options;
      source = resolvedDefaults.source;
    }

    const { items: page } = await listObjects(c.env, record, { prefix: "gh/", limit: 8 });
    const linkToFilePage = resolved.linkToFilePage;
    let items: AttachmentItem[] = page.map((o) => ({
      key: o.key,
      url: o.url,
      embedUrl: o.embedUrl,
      pageUrl: linkToFilePage ? (o.pageUrl ?? null) : null,
    }));
    let sample: "workspace" | "fixtures" = "workspace";
    if (items.length === 0) {
      items = previewFixtureItems(c.env);
      sample = "fixtures";
    }

    const body = attachmentsCommentBody(items, [], attachmentsMarker(name), {
      imageWidth: resolved.imageWidth,
      maxInlineImages: resolved.maxInlineImages,
      metaPath: resolved.metaPath,
      metaState: resolved.metaState,
      note: resolved.note,
    });

    return c.json({ resolved, source, repoConfig, body, sample });
  })

  // Self-serve BYO R2 bucket (issue #583 Task 1.1): read/verify/write/detach
  // of a workspace's storage config. Same audience as the comment-settings
  // triple above (admin/owner only). Issue #613 phase 3: forwards to the
  // canonical handlers in `routes/workspace-settings.ts` — extracted
  // byte-for-byte from the bodies these four routes used to run, so
  // response shape (masked `storageStatusResponse` projection, never
  // credential values) can't drift.
  .get("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/storage`),
  )
  .post("/workspaces/:name/storage/verify", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/storage/verify`),
  )
  .put("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/storage`),
  )
  .delete("/workspaces/:name/storage", (c) =>
    forwardToWorkspaceSettings(c, `/${c.req.param("name")}/storage`),
  );
