/**
 * Session-authenticated admin dashboard endpoints (plan D6/Phase 3 scope B).
 * Gated by `requireAdminUser` (Phase 2's session-based global admin auth,
 * NOT the `ADMIN_TOKEN` gating `/admin/*`) — distinct `/admin-ui/*` prefix so
 * the ops/CI `/admin` surface stays untouched. Backs the /admin page's
 * Workspaces slot on apps/web.
 */
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@uploads/errors";
import { Hono } from "hono";
import {
  EMAIL_PREVIEW_TYPES,
  isEmailPreviewType,
  resolvePreviewRecipient,
  sendEmailPreview,
} from "../admin-email-preview";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  createEnrollment,
  revokeTokensForMintingUser,
  validateScopes,
} from "../auth-db";
import {
  deleteRepoLinkStrict,
  findRepoLinkStrict,
  listRepoLinksForWorkspace,
  setRepoLink,
  type RepoLink,
} from "../github-repo-links";
import { allowWrite } from "../guards";
import { deriveWebOrigin, inviteLinkUrl } from "../invite-links";
import { invitesForOrg, membersForOrg, orgForWorkspace } from "../org-workspaces";
import {
  requireAdminUser,
  requireSessionUser,
  sessionAuth,
  type SessionVars,
} from "../session-auth";
import { getWorkspaceUsage } from "../usage";
import { isPurgedTombstone, loadWorkspaceRecordRaw, type WorkspaceRecord } from "../workspace";
import { LIMIT_FIELDS, validateLimitsPatch } from "../workspace-limits";
import { planResponse, validatePlanPatch } from "../workspace-plan";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAN_REASON_MAX = 500;
const DEFAULT_BAN_REASON = "Banned by operator";

/** Prefer Better Auth's top-level `message`, then nested `error.message`. */
function authErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const p = payload as { message?: unknown; error?: unknown };
  if (typeof p.message === "string" && p.message) return p.message;
  if (typeof p.error === "string" && p.error) return p.error;
  if (p.error && typeof p.error === "object") {
    const nested = (p.error as { message?: unknown }).message;
    if (typeof nested === "string" && nested) return nested;
  }
  return fallback;
}

/**
 * Forward the caller's session cookie/bearer to a Better Auth admin plugin
 * path (ban-user / unban-user). Those endpoints own admin/last-admin/self-ban
 * checks; this layer maps status → AppError.
 */
async function proxyAdminAuth(
  env: Env,
  req: Request,
  path: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = req.headers.get("cookie");
  const authorization = req.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);

  let response: Response;
  try {
    response = await env.AUTH.fetch(`https://auth.internal${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_service_unavailable",
      cause: err,
    });
  }
  return { status: response.status, payload: await response.json().catch(() => null) };
}

function throwAuthAdminError(status: number, payload: unknown, action: "ban" | "unban"): never {
  const message = authErrorMessage(payload, `failed to ${action} user`);
  if (status === 401) throw new UnauthorizedError();
  if (status === 403)
    throw new ForbiddenError(message, { code: "ban_forbidden", details: payload });
  if (status === 404) throw new NotFoundError("user not found", { code: "user_not_found" });
  if (status === 400)
    throw new ValidationError(message, { code: "ban_rejected", details: payload });
  throw new ServiceUnavailableError(message, {
    code: "auth_service_unavailable",
    details: { status, payload },
  });
}

function requireUserIdParam(raw: string): string {
  const userId = raw.trim();
  if (!userId) throw new ValidationError("userId is required", { code: "invalid_user_id" });
  return userId;
}

function userFromAuthPayload(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "user" in payload) {
    return (payload as { user: unknown }).user;
  }
  return payload;
}

function parseBanReason(body: unknown): string {
  if (!body || typeof body !== "object") return DEFAULT_BAN_REASON;
  const raw = (body as { banReason?: unknown }).banReason;
  if (typeof raw !== "string") return DEFAULT_BAN_REASON;
  const trimmed = raw.trim();
  if (trimmed.length > BAN_REASON_MAX) {
    throw new ValidationError(`ban reason must be ≤ ${BAN_REASON_MAX} characters`, {
      code: "ban_reason_too_long",
    });
  }
  return trimmed || DEFAULT_BAN_REASON;
}

// Invite links share the same D1 enrollment records as the ADMIN_TOKEN-gated
// POST /admin/enrollments path (apps/api/src/routes/admin.ts) — same code
// format, same TTL defaults, same redemption flow (apps/web's /invite page
// and `uploads login --code`). This route only adds a session-authed way to
// mint one without an email recipient.
function labelValue(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 100 ? label : null;
}

interface OrgSummary {
  organization: { id: string; slug: string; name: string };
  memberCount: number;
  pendingInviteCount: number;
}

/** Org member/invite counts for the admin workspace list — one AUTH round-trip. */
async function allOrgSummaries(env: Env): Promise<Map<string, OrgSummary>> {
  const response = await env.AUTH.fetch(`https://auth.internal/internal/orgs/summaries`, {
    headers: { "x-uploads-internal": "1" },
  });
  if (!response.ok) return new Map();
  const body = (await response.json().catch(() => null)) as {
    organizations?: OrgSummary[];
  } | null;
  const map = new Map<string, OrgSummary>();
  for (const row of body?.organizations ?? []) {
    if (row?.organization?.slug) map.set(row.organization.slug, row);
  }
  return map;
}

/**
 * Proxies a request to `path` over the AUTH service binding (Lane 1's
 * `/internal/oauth-clients*` routes) and passes the status code + JSON body
 * straight through — the auth worker owns validation of these payloads, this
 * layer only adds the session/admin gate. A binding-level failure (thrown
 * fetch, unparseable response) surfaces as a 503 rather than masquerading as
 * whatever status the caller happened to be checking for.
 */
async function proxyOauthClients(
  env: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  let response: Response;
  try {
    response = await env.AUTH.fetch(`https://auth.internal${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "x-uploads-internal": "1",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_service_unavailable",
      cause: err,
    });
  }
  const payload = await response.json().catch(() => null);
  if (payload === null && response.status >= 500) {
    throw new ServiceUnavailableError("auth service returned a malformed response", {
      code: "auth_service_unavailable",
      details: { status: response.status },
    });
  }
  return Response.json(payload, { status: response.status });
}

/**
 * Raw-reads ws:<name> for a limits edit and 404s on missing / soft-deleted /
 * purged-tombstone records (an admin can't edit limits on a workspace that no
 * longer serves). Uses the uncached raw read so the edit sees the freshest
 * record. Returns a live WorkspaceRecord the caller mutates and writes back.
 */
async function loadEditableWorkspace(env: Env, name: string): Promise<WorkspaceRecord> {
  const record = await loadWorkspaceRecordRaw(env, name);
  if (!record || isPurgedTombstone(record) || record.deletedAt) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
  return record;
}

/** The per-workspace managed-comment booleans (issues #304, #365). */
const GITHUB_COMMENT_SETTING_KEYS = [
  "githubCommentLinkToFilePage",
  "githubCommentShowMetadata",
] as const;

type GithubCommentSettingsPatch = Partial<
  Record<(typeof GITHUB_COMMENT_SETTING_KEYS)[number], boolean>
>;

/**
 * Validates a PATCH body for the github-comment settings route. Only the known
 * booleans are accepted; when present each must be a boolean. An omitted key
 * means "leave unchanged" — distinct from a validation error, mirroring
 * `validateLimitsPatch`'s omit-vs-invalid distinction.
 */
function validateGithubCommentSettingsPatch(body: unknown): GithubCommentSettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be an object", { code: "invalid_settings" });
  }
  const patch: GithubCommentSettingsPatch = {};
  for (const key of GITHUB_COMMENT_SETTING_KEYS) {
    const raw = (body as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") {
      throw new ValidationError(`${key} must be a boolean`, { code: "invalid_settings" });
    }
    patch[key] = raw;
  }
  return patch;
}

/** Response body shared by GET and PATCH: the github-comment settings. */
function githubCommentSettingsResponse(name: string, record: WorkspaceRecord) {
  return {
    workspace: name,
    settings: {
      githubCommentLinkToFilePage: record.githubCommentLinkToFilePage ?? null,
      githubCommentShowMetadata: record.githubCommentShowMetadata ?? null,
    },
  };
}

// Same owner/name grammar + dot-only-segment guard as routes/github-link.ts's
// parseRepo (issue #318 operator-override routes below).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

function parseRepoParam(repo: unknown): string {
  if (
    typeof repo !== "string" ||
    !REPO_RE.test(repo) ||
    repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg))
  ) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  return repo;
}

function repoLinkResponse(link: RepoLink) {
  return {
    repo: link.repo,
    workspace: link.workspaceName,
    source: link.source,
    installationId: link.installationId,
    createdAt: link.createdAt,
  };
}

/** Response body shared by GET and PATCH: current budget limits + usage. */
async function limitsResponse(env: Env, name: string, record: WorkspaceRecord) {
  const limits = {
    maxStorageBytes: record.maxStorageBytes ?? null,
    maxUploadsPerPeriod: record.maxUploadsPerPeriod ?? null,
    maxUploadBytes: record.maxUploadBytes ?? null,
    maxVideoUploadBytes: record.maxVideoUploadBytes ?? null,
  };
  let usage: { bytes: number; uploads: number } | null = null;
  try {
    const u = await getWorkspaceUsage(env.DB, name);
    usage = { bytes: u.bytes, uploads: u.uploadsInPeriod };
  } catch {
    usage = null;
  }
  return { workspace: name, limits, usage };
}

export const adminUi = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser, requireAdminUser)

  // List every KV workspace joined with its org + member/invite counts.
  .get("/workspaces", async (c) => {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
      for (const entry of page.keys) {
        const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
        if (name) names.push(name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    const summaries = await allOrgSummaries(c.env);
    const workspaces = names.map((name) => {
      const summary = summaries.get(name);
      return {
        workspace: name,
        organization: summary?.organization ?? null,
        memberCount: summary?.memberCount ?? 0,
        pendingInviteCount: summary?.pendingInviteCount ?? 0,
      };
    });
    return c.json({ workspaces });
  })

  // Members of the org backing this workspace.
  .get("/workspaces/:name/members", async (c) => {
    const name = c.req.param("name");
    const org = await orgForWorkspace(c.env, name);
    if (!org)
      throw new NotFoundError("no organization for this workspace", { code: "org_not_found" });

    return c.json({ members: await membersForOrg(c.env, org.slug) });
  })

  // Pending invites for the org backing this workspace.
  .get("/workspaces/:name/invites", async (c) => {
    const name = c.req.param("name");
    const org = await orgForWorkspace(c.env, name);
    if (!org)
      throw new NotFoundError("no organization for this workspace", { code: "org_not_found" });

    return c.json({ invites: await invitesForOrg(c.env, org.slug) });
  })

  // Invite an email to the org backing this workspace.
  .post("/workspaces/:name/invites", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const org = await orgForWorkspace(c.env, name);
    if (!org) {
      // KV workspace exists but no org has been provisioned for it yet
      // (backfill hasn't run, or it's a fresh workspace). Point the caller
      // at the backfill rather than silently auto-provisioning here.
      throw new NotFoundError("no organization for this workspace — run the org backfill first", {
        code: "org_not_found",
      });
    }

    const body = await c.req
      .json<{ email?: unknown; role?: unknown }>()
      .catch(() => ({}) as { email?: unknown; role?: unknown });
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "member";
    if (!email || !EMAIL_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }
    if (role !== "member" && role !== "admin") {
      throw new ValidationError("role must be member or admin", { code: "invalid_role" });
    }

    const inviterUserId = c.get("sessionUser")?.id;
    if (!inviterUserId)
      throw new ValidationError("missing session user", { code: "invalid_session" });

    const response = await c.env.AUTH.fetch("https://auth.internal/internal/invite", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploads-internal": "1" },
      body: JSON.stringify({ organizationSlug: org.slug, email, role, inviterUserId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ValidationError("failed to create invitation", { details: payload });
    }
    return c.json(payload as object, 201);
  })

  // Mint a redeemable invite link/code for this workspace — the session-authed
  // counterpart to POST /admin/enrollments, for sharing a URL/code without
  // knowing the invitee's email. Backed by the same auth_enrollments table
  // (see createEnrollment in ../auth-db), so the resulting link works
  // unchanged with apps/web's /invite page and `uploads login --code`.
  .post("/workspaces/:name/invite-links", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const existing = await c.env.REGISTRY.get(`ws:${name}`);
    if (!existing) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const body = await c.req
      .json<{ label?: unknown; scopes?: unknown }>()
      .catch(() => ({}) as { label?: unknown; scopes?: unknown });
    const label = labelValue(body.label);
    if (label === null) {
      throw new ValidationError("label must be between 1 and 100 characters", {
        code: "invalid_label",
      });
    }
    const scopes = validateScopes(body.scopes, ["files:read", "files:write"]);
    if (!scopes) throw new ValidationError("invalid scopes", { code: "invalid_scopes" });

    const enrollment = await createEnrollment(c.env.DB, {
      workspace: name,
      label,
      scopes,
      enrollmentSeconds: DEFAULT_ENROLLMENT_SECONDS,
      tokenSeconds: DEFAULT_TOKEN_SECONDS,
    });

    const webOrigin = c.env.WEB_ORIGIN || deriveWebOrigin(c.req.url);
    const url = inviteLinkUrl(webOrigin, enrollment.pageId, enrollment.code);

    return c.json(
      {
        workspace: name,
        label: label ?? null,
        scopes,
        url,
        ...enrollment,
      },
      201,
    );
  })

  // Read the four budget limits (+ current usage) for one workspace.
  .get("/workspaces/:name/limits", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(await limitsResponse(c.env, name, record));
  })

  // Patch the four budget limits. Each field is optional; a positive integer
  // sets the cap, null clears it (-> unlimited), omitted leaves it unchanged.
  // The whole record is written back so non-budget fields are preserved.
  .patch("/workspaces/:name/limits", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const record = await loadEditableWorkspace(c.env, name);
    // Distinguish malformed JSON (400) from an intentionally empty object
    // (a no-op patch): swallowing a parse failure into `{}` would silently
    // 200 on a broken request and rewrite the record unchanged.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_limit" });
    }
    const patch = validateLimitsPatch(body);
    for (const field of LIMIT_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      if (value === null) delete record[field];
      else record[field] = value;
    }
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(await limitsResponse(c.env, name, record));
  })

  // Read the workspace's plan, its availability, and resolved effective
  // limits (plan defaults backstopped by any explicit overrides).
  .get("/workspaces/:name/plan", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(planResponse(name, record));
  })

  // Set the workspace's plan. Admins may set `pro` even though it's
  // unavailable to self-serve users (operator override) — availability is
  // informational in the response, not enforced here. Limit overrides on
  // the record are untouched; only `plan` is written.
  .patch("/workspaces/:name/plan", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const record = await loadEditableWorkspace(c.env, name);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_plan" });
    }
    const { plan } = validatePlanPatch(body);
    record.plan = plan;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(planResponse(name, record));
  })

  // Read the per-workspace managed-comment settings: whether attachments
  // link to their `/f/` file page or raw object bytes (issue #304), and
  // whether the comment shows an upload's `path`/`state` metadata (issue
  // #365).
  .get("/workspaces/:name/settings", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(githubCommentSettingsResponse(name, record));
  })

  // Patch the managed-comment settings above (file-page linking, #304; the
  // path/state metadata toggle, #365). Either key may be omitted to leave it
  // unchanged; the whole record is read-modify-written so other fields
  // (limits, tokens, etc.) survive untouched.
  .patch("/workspaces/:name/settings", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const record = await loadEditableWorkspace(c.env, name);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_settings" });
    }
    const patch = validateGithubCommentSettingsPatch(body);
    for (const key of GITHUB_COMMENT_SETTING_KEYS) {
      if (key in patch) record[key] = patch[key];
    }
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(githubCommentSettingsResponse(name, record));
  })

  // Admin visibility (issue #318): the repos this workspace has claimed in
  // `github_repo_links`. Read-only — reassigning/removing a binding is the
  // dedicated /github-links routes below, which act on the repo (any
  // workspace), not scoped to one workspace's list.
  .get("/workspaces/:name/github-links", async (c) => {
    const name = c.req.param("name");
    const links = await listRepoLinksForWorkspace(c.env.DB, name);
    return c.json({ workspace: name, links: links.map(repoLinkResponse) });
  })

  // Operator override (issue #318): forcibly reassign a repo's binding to
  // `workspace`, overwriting whichever workspace claimed it first. Unlike the
  // self-serve `/v1/:workspace/github/link` POST (first-claim-wins), this
  // never reports `claimed: false` — an admin's call always wins. Rate
  // limited (and workspace-existence checked) against the destination
  // workspace, same as the other admin-ui writes below.
  .put("/github-links", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_body" });
    }
    const { repo: rawRepo, workspace: rawWorkspace } = (body ?? {}) as {
      repo?: unknown;
      workspace?: unknown;
    };
    const repo = parseRepoParam(rawRepo);
    if (typeof rawWorkspace !== "string" || !rawWorkspace.trim()) {
      throw new ValidationError("workspace is required", { code: "invalid_workspace" });
    }
    const workspace = rawWorkspace.trim();
    // A typo'd destination would otherwise silently create a binding owned
    // by a workspace that doesn't exist (CodeRabbit, issue #318).
    const existing = await c.env.REGISTRY.get(`ws:${workspace}`);
    if (!existing) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    if (!(await allowWrite(c.env, workspace))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    await setRepoLink(c.env.DB, repo, workspace, "admin");
    return c.json({ repo, workspace, reassigned: true });
  })

  // Operator override (issue #318): remove any repo's binding outright
  // (stuck/abandoned claim, no replacement owner). Unlike the self-serve
  // DELETE (workspace-scoped, refuses non-owners), this always succeeds
  // regardless of who owns the binding. Uses the strict lookup/delete so a
  // D1 failure surfaces as an error rather than a false `unlinked: true`
  // (CodeRabbit, issue #318); rate limited against the current owner
  // (there's no destination workspace to key on, unlike PUT above).
  .delete("/github-links", async (c) => {
    const repo = parseRepoParam(c.req.query("repo"));
    const before = await findRepoLinkStrict(c.env.DB, repo);
    if (!before) {
      return c.json({ repo, unlinked: false, reason: "not_linked" as const });
    }
    if (!(await allowWrite(c.env, before.workspaceName))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const removed = await deleteRepoLinkStrict(c.env.DB, repo);
    return c.json({ repo, unlinked: removed });
  })

  // Ban / unban (abuse). Proxies Better Auth admin ban/unban; ban also
  // soft-revokes workspace API tokens the user minted.
  .post("/users/:userId/ban", async (c) => {
    const userId = requireUserIdParam(c.req.param("userId"));
    if (c.get("sessionUser")?.id === userId) {
      throw new ValidationError("you cannot ban yourself", { code: "cannot_ban_self" });
    }
    const banReason = parseBanReason(await c.req.json().catch(() => ({})));
    const { status, payload } = await proxyAdminAuth(c.env, c.req.raw, "/api/auth/admin/ban-user", {
      userId,
      banReason,
    });
    if (status < 200 || status >= 300) throwAuthAdminError(status, payload, "ban");

    // Best-effort: ban already wiped sessions; a D1 blip must not undo it.
    let tokensRevoked = 0;
    try {
      tokensRevoked = await revokeTokensForMintingUser(c.env.DB, userId);
    } catch {
      tokensRevoked = 0;
    }
    return c.json({ user: userFromAuthPayload(payload), tokensRevoked });
  })

  .post("/users/:userId/unban", async (c) => {
    const userId = requireUserIdParam(c.req.param("userId"));
    const { status, payload } = await proxyAdminAuth(
      c.env,
      c.req.raw,
      "/api/auth/admin/unban-user",
      { userId },
    );
    if (status < 200 || status >= 300) throwAuthAdminError(status, payload, "unban");
    return c.json({ user: userFromAuthPayload(payload) });
  })

  // OAuth client registrations — proxied 1:1 to Lane 1's internal routes
  // (see .context/2026-07-18-oauth-admin-panel-contract.md). Never re-validate
  // beyond parsing JSON; the auth worker owns validation.
  .get("/oauth-clients", async (c) => proxyOauthClients(c.env, "/internal/oauth-clients"))

  .get("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    return proxyOauthClients(c.env, `/internal/oauth-clients/${encodeURIComponent(clientId)}`);
  })

  .post("/oauth-clients", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return proxyOauthClients(c.env, "/internal/oauth-clients", { method: "POST", body });
  })

  .patch("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    const body = await c.req.json().catch(() => ({}));
    return proxyOauthClients(c.env, `/internal/oauth-clients/${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      body,
    });
  })

  .delete("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    return proxyOauthClients(c.env, `/internal/oauth-clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
    });
  })

  // Transactional email previews — operator self-send with placeholder tokens.
  // Type list is also hard-coded in apps/web admin/email.astro (keep in sync).
  .get("/dev/emails", (c) => c.json({ types: EMAIL_PREVIEW_TYPES }))

  .post("/dev/emails/:type", async (c) => {
    const type = c.req.param("type");
    if (!isEmailPreviewType(type)) {
      throw new ValidationError("unknown email preview type", {
        code: "unknown_email_preview_type",
        details: { type },
      });
    }
    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
    const to = resolvePreviewRecipient(c.get("sessionUser")?.email, body.to);
    const { subject } = await sendEmailPreview(c.env, type, to);
    return c.json({ ok: true, type, to, subject });
  });
