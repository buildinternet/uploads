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
  NOTE_MAX_CHARS,
  resolveCommentOptions,
  type OptionSource,
  type ResolvedCommentOptions,
} from "@uploads/comment-config";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { createFilesRouter, type R2Jurisdiction } from "@uploads/storage";
import { Hono, type Context } from "hono";
import { usageWithLimits } from "../budget";
import { sealCredentialFieldsStrict } from "../secrets";
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
import { allowWrite } from "../guards";
import {
  adminWorkspaceOr403,
  memberWorkspaceOr404,
  membershipsForUser,
  myWorkspaceFromMembership,
  subscriptionForOrg,
  workspacesFromMembership,
  type Membership,
  type MyWorkspace,
} from "../org-workspaces";
import { presetResolvedSessionUser } from "../dual-workspace-auth";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import { storage } from "../storage";
import { getWorkspaceUsage } from "../usage";
import { byoBucketAllowed, loadWorkspaceRecord, type WorkspaceRecord } from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { planResponse, planSourceFor } from "../workspace-plan";
import { workspaceFiles } from "./workspace-files";
import { workspaceMembers } from "./workspace-members";
import { workspaceUsage } from "./workspace-usage";
import { workspaces } from "./workspaces";
import {
  candidateFromBody,
  storageReconcile,
  storageStatusResponse,
  storageVerify,
} from "./workspace-storage";

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

/** `imageWidth` bounds (issue #307): "full" or an integer clamp width in px. */
const COMMENT_IMAGE_WIDTH_MIN = 160;
const COMMENT_IMAGE_WIDTH_MAX = 1000;
/** `maxInlineImages` bounds (issue #307). */
const COMMENT_MAX_INLINE_IMAGES_MIN = 1;
const COMMENT_MAX_INLINE_IMAGES_MAX = 48;

/** The five workspace-level comment-defaults fields (issue #307). */
const COMMENT_SETTINGS_KEYS = [
  "imageWidth",
  "maxInlineImages",
  "showMetadata",
  "linkToFilePage",
  "note",
] as const;
type CommentSettingsKey = (typeof COMMENT_SETTINGS_KEYS)[number];

/** Record field each API key writes to. */
const COMMENT_SETTINGS_RECORD_FIELD: Record<CommentSettingsKey, keyof WorkspaceRecord> = {
  imageWidth: "githubCommentImageWidth",
  maxInlineImages: "githubCommentMaxInlineImages",
  showMetadata: "githubCommentShowMetadata",
  linkToFilePage: "githubCommentLinkToFilePage",
  note: "githubCommentNote",
};

type CommentSettingsValue = string | number | boolean;
type CommentSettingsPatch = Partial<Record<CommentSettingsKey, CommentSettingsValue | null>>;

/**
 * Validates a PATCH body for the workspace-level managed-comment defaults
 * (issue #307). This is the single enforcement point for the bounds the
 * resolver itself does not clamp (a review finding on the Task 1 parser):
 * imageWidth "full" or an integer 160–1000, maxInlineImages an integer
 * 1–48, and note trimmed, non-empty, and at most `NOTE_MAX_CHARS`. Reject-
 * all-or-apply-all — the whole body is checked before any record mutation,
 * so an invalid field never partially applies. An omitted key means "leave
 * unchanged"; an explicit `null` clears the field. Unknown keys are
 * ignored, mirroring `validateGithubCommentSettingsPatch` (admin-ui.ts) and
 * `validateLimitsPatch` (workspace-limits.ts), the two sibling workspace-
 * record PATCH validators in this codebase.
 */
function validateCommentSettingsPatch(body: unknown): CommentSettingsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object", { code: "invalid_settings" });
  }
  const record = body as Record<string, unknown>;
  const patch: CommentSettingsPatch = {};

  if ("imageWidth" in record) {
    const value = record.imageWidth;
    if (value === null) {
      patch.imageWidth = null;
    } else if (value === "full") {
      patch.imageWidth = "full";
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_IMAGE_WIDTH_MIN &&
      value <= COMMENT_IMAGE_WIDTH_MAX
    ) {
      patch.imageWidth = value;
    } else {
      throw new ValidationError(
        `imageWidth must be "full", an integer ${COMMENT_IMAGE_WIDTH_MIN}–${COMMENT_IMAGE_WIDTH_MAX}, or null`,
        { code: "invalid_settings", details: { field: "imageWidth" } },
      );
    }
  }

  if ("maxInlineImages" in record) {
    const value = record.maxInlineImages;
    if (value === null) {
      patch.maxInlineImages = null;
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_MAX_INLINE_IMAGES_MIN &&
      value <= COMMENT_MAX_INLINE_IMAGES_MAX
    ) {
      patch.maxInlineImages = value;
    } else {
      throw new ValidationError(
        `maxInlineImages must be an integer ${COMMENT_MAX_INLINE_IMAGES_MIN}–${COMMENT_MAX_INLINE_IMAGES_MAX} or null`,
        { code: "invalid_settings", details: { field: "maxInlineImages" } },
      );
    }
  }

  if ("showMetadata" in record) {
    const value = record.showMetadata;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("showMetadata must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "showMetadata" },
      });
    }
    patch.showMetadata = value;
  }

  if ("linkToFilePage" in record) {
    const value = record.linkToFilePage;
    if (value !== null && typeof value !== "boolean") {
      throw new ValidationError("linkToFilePage must be a boolean or null", {
        code: "invalid_settings",
        details: { field: "linkToFilePage" },
      });
    }
    patch.linkToFilePage = value;
  }

  if ("note" in record) {
    const value = record.note;
    if (value === null) {
      patch.note = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > NOTE_MAX_CHARS) {
        throw new ValidationError(`note must be 1–${NOTE_MAX_CHARS} characters after trimming`, {
          code: "invalid_settings",
          details: { field: "note" },
        });
      }
      patch.note = trimmed;
    } else {
      throw new ValidationError("note must be a string or null", {
        code: "invalid_settings",
        details: { field: "note" },
      });
    }
  }

  return patch;
}

/** Response body shared by GET and PATCH: the workspace-level comment defaults. */
function commentSettingsResponse(record: WorkspaceRecord) {
  return {
    imageWidth: record.githubCommentImageWidth ?? null,
    maxInlineImages: record.githubCommentMaxInlineImages ?? null,
    showMetadata: record.githubCommentShowMetadata ?? null,
    linkToFilePage: record.githubCommentLinkToFilePage ?? null,
    note: record.githubCommentNote ?? null,
  };
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
  .get("/workspaces/:name/summary", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const publicBaseUrl = record.publicBaseUrl;
    let usage: ReturnType<typeof usageWithLimits> | null = null;
    if (record) {
      try {
        usage = usageWithLimits(await getWorkspaceUsage(c.env.DB, name), record);
      } catch {
        usage = null;
      }
    }

    return c.json({
      workspace: ws.workspace,
      organization: ws.organization,
      role: ws.role,
      hasPublicUrl: Boolean(publicBaseUrl),
      publicBaseUrl,
      usage,
    });
  })

  // Plan metadata, resolved effective limits, usage, and subscription state
  // for the account billing tab — 404s unless the caller is a member.
  // `plan`/`available`/`planApplied`/`limits` reuse workspace-plan.ts's
  // `planResponse` — the same attribution contract the admin plan surface
  // uses (Task 5's Critical fix): a record with no `plan` field must never
  // display free-plan default caps it isn't actually enforcing, so
  // `planApplied` is `false` and `limits` mirrors enforcement
  // (explicit-or-unlimited) rather than the plan defaults.
  //
  // `planSource`/`subscription` (issue #445, purely additive to the shape
  // above — a billing-tab lane builds its UI against this) are sourced from
  // the auth D1 `subscription` table over the AUTH service binding
  // (org-workspaces.ts's `subscriptionForOrg`), the same internal-bridge
  // pattern as every other org lookup here. `subscriptionForOrg` never
  // throws — an AUTH outage degrades to `subscription: null` +
  // `planSource: "none"`-or-"admin" (whichever `planSourceFor` derives with a
  // null subscription) rather than a 500. `stripeCustomerId` is deliberately
  // dropped here — it's an admin-ui-only field (see routes/admin-ui.ts's
  // plan surface), never exposed to the member-facing /me API.
  .get("/workspaces/:name/billing", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const { plan, available, planApplied, limits } = planResponse(name, record);

    const [usage, authSubscription] = await Promise.all([
      getWorkspaceUsage(c.env.DB, name)
        .then((raw) => usageWithLimits(raw, record))
        .catch(() => null),
      subscriptionForOrg(c.env, ws.organization.slug),
    ]);

    const planSource = planSourceFor(record, authSubscription);
    const subscription = authSubscription
      ? {
          status: authSubscription.status,
          periodEnd: authSubscription.periodEnd,
          cancelAtPeriodEnd: authSubscription.cancelAtPeriodEnd,
        }
      : null;

    return c.json({
      workspace: ws.workspace,
      organization: ws.organization,
      plan,
      available,
      planApplied,
      limits,
      usage,
      planSource,
      subscription,
    });
  })

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
  // unless a repo's `.uploads.yml` overrides them.
  .get("/workspaces/:name/comment-settings", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    return c.json(commentSettingsResponse(record));
  })

  // Patch the defaults above. Validated in full before any write (reject-
  // all-or-apply-all — see `validateCommentSettingsPatch`); an omitted key
  // leaves the field unchanged, an explicit `null` clears it.
  .patch("/workspaces/:name/comment-settings", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_settings" });
    }
    const patch = validateCommentSettingsPatch(body);
    const record = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => {
        const next = { ...current };
        for (const key of COMMENT_SETTINGS_KEYS) {
          if (!(key in patch)) continue;
          const field = COMMENT_SETTINGS_RECORD_FIELD[key];
          const value = patch[key];
          if (value === null || value === undefined) delete next[field];
          else (next as Record<string, unknown>)[field] = value;
        }
        return next;
      },
      { requireServing: true },
    );
    return c.json(commentSettingsResponse(record));
  })

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
  // triple above (admin/owner only) — storage config is workspace-wide and
  // security sensitive. Readable regardless of `byoBucketEnabled` (the
  // settings UI needs the flag value to decide whether to show the panel at
  // all); verify/write/detach 403 when the flag is off (fail-closed, see
  // `byoBucketAllowed` in workspace.ts). Never returns credential values —
  // `storageStatusResponse` (workspace-storage.ts) projects masked/presence
  // fields only, same posture as `GET /admin/workspaces/:name` (admin.ts).
  .get("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    await adminWorkspaceOr403(c.env, requireUserId(c), name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    return c.json(storageStatusResponse(record, byoBucketAllowed(record)));
  })

  // Runs the verify pipeline (storage-verify.ts) against the request body —
  // never saved state — so an admin can iterate on credentials before
  // anything is persisted. Rate-limited via `allowWrite` like every other
  // mutating-adjacent route here: each call does real remote I/O (auth
  // probe + a write/read/delete round-trip against the candidate bucket).
  .post("/workspaces/:name/storage/verify", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    if (!byoBucketAllowed(record)) {
      throw new ForbiddenError("BYO storage is not enabled for this workspace", {
        code: "byo_bucket_disabled",
      });
    }
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const body = await c.req.json().catch(() => null);
    const candidate = candidateFromBody(body);
    const result = await storageVerify(candidate);
    return c.json(result);
  })

  // Persist a verified BYO config. Never trusts a client-side "verified"
  // claim — re-runs the same pipeline server-side against the request body,
  // and only writes on a pass. On a fail, responds with the verify result
  // (422) so the UI can render the same checklist the standalone verify
  // route would have. `mutateWorkspaceRecord` (with `requireServing`) both
  // re-checks the workspace hasn't been soft-deleted since the request
  // started and gives us the read-immediately-before-write window issue #387
  // exists for; sealing happens *inside* that callback (precedent:
  // `reencrypt-registry.ts`), never on data read earlier in the request.
  .put("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    if (!byoBucketAllowed(record)) {
      throw new ForbiddenError("BYO storage is not enabled for this workspace", {
        code: "byo_bucket_disabled",
      });
    }
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const body = await c.req.json().catch(() => null);
    const candidate = candidateFromBody(body);
    const result = await storageVerify(candidate);
    if (!result.ok) {
      return c.json(result, 422);
    }

    // No migration of populated workspaces in v1 (plan's global constraints):
    // attaching a BYO bucket to a workspace that already holds files would
    // orphan them on the shared bucket. Checked against the D1 usage ledger
    // *before* the mutation — a KV-only read inside the callback can't see
    // this — accepting the narrow race where a concurrent upload lands
    // between this check and the write (the callback's `requireServing`
    // re-check guards the record itself, not usage).
    const usage = await getWorkspaceUsage(c.env.DB, name);
    if (usage.objects > 0 && candidate.adoptExistingContents !== true) {
      throw new ConflictError(
        "this workspace already has files — BYO storage can only be attached to an empty workspace",
        { code: "workspace_storage_not_empty" },
      );
    }

    const nowIso = new Date().toISOString();
    const updated = await mutateWorkspaceRecord(
      c.env,
      name,
      async (current) => {
        const sealed = await sealCredentialFieldsStrict(c.env.WORKSPACE_SECRETS_KEY, {
          accessKeyId: candidate.accessKeyId,
          secretAccessKey: candidate.secretAccessKey,
        });
        const next: WorkspaceRecord = { ...current };
        delete next.prefix;
        delete next.binding;
        next.bucket = candidate.bucket;
        next.accountId = candidate.accountId;
        next.accessKeyId = sealed.accessKeyId;
        next.secretAccessKey = sealed.secretAccessKey;
        if (candidate.publicBaseUrl) next.publicBaseUrl = candidate.publicBaseUrl;
        else delete next.publicBaseUrl;
        // Cast is safe: `storageVerify` above already ran the shape check
        // (storage-verify.ts) that 422s on anything outside R2_JURISDICTIONS.
        if (candidate.jurisdiction) next.jurisdiction = candidate.jurisdiction as R2Jurisdiction;
        else delete next.jurisdiction;
        next.storageConfiguredAt = nowIso;
        next.storageVerifiedAt = nowIso;
        next.storageConfiguredBy = userId;
        // Display fragment for the settings UI, captured from the plaintext
        // before sealing — `next.accessKeyId` is ciphertext from here on.
        next.storageAccessKeyIdLast4 = candidate.accessKeyId.slice(-4);
        return next;
      },
      { requireServing: true },
    );

    console.log(JSON.stringify({ event: "workspace_storage_configured", workspace: name, userId }));

    // `adoptExistingContents` bypassed the emptiness guard, so the D1 usage
    // ledger still describes the old backing storage while the adopted
    // bucket's contents are what this workspace now serves. Rebuild the
    // ledger from the new bucket so it's honest immediately (it's dormant
    // for `maxStorageBytes` while BYO is active — `storageBudgetApplies` —
    // but powers the settings UI and becomes authoritative again on detach).
    // Best-effort: the config write above already succeeded, and reconcile
    // can be re-run any time.
    if (candidate.adoptExistingContents === true) {
      await storageReconcile(c.env, updated, name).catch((err) =>
        console.error("workspace storage attach: usage reconcile failed for", name, err),
      );
    }

    return c.json({ ...storageStatusResponse(updated, true), verify: result });
  })

  // Detach BYO storage and restore shared-bucket defaults. Never touches the
  // customer's bucket or its objects — only the platform's own KV record.
  // Blocked unless the workspace's usage ledger reports zero objects, or the
  // caller explicitly passes `force` (query `?force=true` or a JSON body
  // `{ "force": true }`) — mirrors the empty-workspace guard on PUT above,
  // in the opposite direction. Shared-bucket fields (bucket/binding/prefix/
  // publicBaseUrl) come from `selfServeWorkspaceRecord` so this can't drift
  // from what a brand-new self-serve workspace actually gets; everything
  // else on the record (limits, github links, comment settings, plan, other
  // flags) is preserved untouched.
  .delete("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    const userId = requireUserId(c);
    await adminWorkspaceOr403(c.env, userId, name);
    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    if (!byoBucketAllowed(record)) {
      throw new ForbiddenError("BYO storage is not enabled for this workspace", {
        code: "byo_bucket_disabled",
      });
    }
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }

    const queryForce = c.req.query("force");
    const bodyForce = await c.req
      .json<{ force?: unknown }>()
      .then((b) => b?.force === true)
      .catch(() => false);
    const force = queryForce === "true" || queryForce === "1" || bodyForce;

    if (!force) {
      const usage = await getWorkspaceUsage(c.env.DB, name);
      if (usage.objects > 0) {
        throw new ConflictError(
          "this workspace still has files on its BYO bucket — pass force to detach anyway",
          { code: "workspace_storage_not_empty" },
        );
      }
    }

    const updated = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => {
        const shared = selfServeWorkspaceRecord({
          name,
          userId: current.createdByUserId ?? userId,
          now: new Date(),
        });
        const next: WorkspaceRecord = { ...current };
        next.bucket = shared.bucket;
        next.binding = shared.binding;
        next.prefix = shared.prefix;
        if (shared.publicBaseUrl) next.publicBaseUrl = shared.publicBaseUrl;
        else delete next.publicBaseUrl;
        delete next.accountId;
        delete next.accessKeyId;
        delete next.secretAccessKey;
        delete next.jurisdiction;
        delete next.storageConfiguredAt;
        delete next.storageVerifiedAt;
        delete next.storageConfiguredBy;
        delete next.storageAccessKeyIdLast4;
        return next;
      },
      { requireServing: true },
    );

    console.log(JSON.stringify({ event: "workspace_storage_detached", workspace: name, userId }));

    // `force` bypassed the emptiness guard, so the ledger still describes
    // the detached BYO bucket — but `maxStorageBytes` enforcement resumes on
    // the shared bucket the moment this record is restored, and stale counts
    // could leave the workspace permanently over-budget with nothing to
    // delete. Rebuild from the restored shared-bucket prefix (best-effort,
    // same rationale as the attach path above).
    if (force) {
      await storageReconcile(c.env, updated, name).catch((err) =>
        console.error("workspace storage detach: usage reconcile failed for", name, err),
      );
    }

    return c.json(storageStatusResponse(updated, byoBucketAllowed(updated)));
  });
