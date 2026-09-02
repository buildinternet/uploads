/**
 * Session-authenticated admin dashboard endpoints (plan D6/Phase 3 scope B).
 * Gated by `requireAdminUser` (Phase 2's session-based global admin auth,
 * NOT the `ADMIN_TOKEN` gating `/admin/*`) — distinct `/admin-ui/*` prefix so
 * the ops/CI `/admin` surface stays untouched. Backs the /admin page's
 * Workspaces slot on apps/web.
 */
import { NOTE_MAX_CHARS } from "@uploads/comment-config";
import { runActiveContentHostSweep } from "../active-content-hosts";
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
  fetchBreakdown,
  fetchSlowOps,
  type BreakdownDimension,
  type SlowOpWindow,
} from "../analytics-engine";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  createEnrollment,
  labelValue,
  listOpenEnrollments,
  revokeEnrollment,
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
import { throwForInviteError } from "../invite-error";
import { deriveWebOrigin, inviteLinkUrl } from "../invite-links";
import { ALLOWED_WINDOWS, cachedOverview } from "../metrics-overview";
import {
  invitesForOrg,
  membersForOrg,
  orgForWorkspace,
  subscriptionForOrg,
} from "../org-workspaces";
import {
  authRateLimitError,
  requireAdminUser,
  requireSessionUser,
  sessionAuth,
  type SessionVars,
} from "../session-auth";
import { getWorkspaceUsage } from "../usage";
import {
  byoBucketAllowed,
  isPurgedTombstone,
  loadWorkspaceRecordRaw,
  type WorkspaceRecord,
} from "../workspace";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { LIMIT_FIELDS, validateLimitsPatch } from "../workspace-limits";
import { planResponse, planSourceFor, validatePlanPatch } from "../workspace-plan";
import { resolveEffectiveLimits, type WorkspacePlanLimits } from "@uploads/billing";
import { storageStatusResponse } from "./workspace-storage";
import { dbFor } from "../db-session";

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
  // Client IP headers included so Better Auth rate-limits per caller (same
  // convention as session-auth.ts).
  for (const name of ["cookie", "authorization", "cf-connecting-ip", "x-forwarded-for"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

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
  // Rate limiting is the caller's problem, not an outage — surface it before
  // the status → AppError mapping turns it into a 503.
  if (response.status === 429) throw authRateLimitError(response);
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
// mint one without an email recipient. `labelValue` (shared with
// `routes/workspace-members.ts`'s member-kind links) lives in `auth-db.ts`.

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

/** One row of the `/admin-ui/workspaces` list: the KV workspace + its org counts. */
function workspaceSummaryResponse(name: string, summary: OrgSummary | undefined) {
  return {
    workspace: name,
    organization: summary?.organization ?? null,
    memberCount: summary?.memberCount ?? 0,
    pendingInviteCount: summary?.pendingInviteCount ?? 0,
  };
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

/**
 * Issue #445 (task 2): subscription enrichment for the admin panel's plan
 * view — `planSource` reuses workspace-plan.ts's `planSourceFor` (the same
 * helper /me/workspaces/:name/billing calls), and `stripeCustomerId` is
 * included here ONLY (never in /me responses) as a deep-link target for
 * support work: `https://dashboard.stripe.com/customers/<id>`, built
 * client-side in apps/web so this stays a plain id, not a baked-in URL.
 * `subscriptionForOrg` never throws — an AUTH outage degrades to
 * `planSource` derived from a `null` subscription and `subscription: null`
 * rather than a 500, same fail-soft contract as the /me surface.
 */
async function adminSubscriptionInfo(env: Env, workspaceName: string, record: WorkspaceRecord) {
  const org = await orgForWorkspace(env, workspaceName);
  const authSubscription = org ? await subscriptionForOrg(env, org.slug) : null;
  return {
    planSource: planSourceFor(record, authSubscription),
    subscription: authSubscription
      ? {
          status: authSubscription.status,
          periodEnd: authSubscription.periodEnd,
          cancelAtPeriodEnd: authSubscription.cancelAtPeriodEnd,
          stripeCustomerId: authSubscription.stripeCustomerId,
        }
      : null,
  };
}

/**
 * Per-workspace managed-comment defaults on the operator admin-ui surface
 * (issues #304, #365, #307 / #535). Record-field keys (not the short me.ts
 * names) — operators patch the KV record shape directly. Bounds for the
 * three #534 fields match `validateCommentSettingsPatch` in me.ts.
 */
const COMMENT_IMAGE_WIDTH_MIN = 160;
const COMMENT_IMAGE_WIDTH_MAX = 1000;
const COMMENT_MAX_INLINE_IMAGES_MIN = 1;
const COMMENT_MAX_INLINE_IMAGES_MAX = 48;

const GITHUB_COMMENT_BOOLEAN_KEYS = [
  "githubCommentLinkToFilePage",
  "githubCommentShowMetadata",
  "githubCommentRequireActorOnPr",
] as const;

type GithubCommentSettingsPatch = {
  githubCommentLinkToFilePage?: boolean;
  githubCommentShowMetadata?: boolean;
  githubCommentRequireActorOnPr?: boolean;
  githubCommentImageWidth?: "full" | number | null;
  githubCommentMaxInlineImages?: number | null;
  githubCommentNote?: string | null;
};

/**
 * Validates a PATCH body for the github-comment settings route. Known keys
 * only; omitted means leave unchanged. Reject-all-or-apply-all. For the three
 * #534 fields, explicit `null` clears (same as me.ts comment-settings).
 * Unknown keys are ignored (validateLimitsPatch precedent).
 */
function validateGithubCommentSettingsPatch(body: unknown): GithubCommentSettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be an object", { code: "invalid_settings" });
  }
  const record = body as Record<string, unknown>;
  const patch: GithubCommentSettingsPatch = {};

  for (const key of GITHUB_COMMENT_BOOLEAN_KEYS) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") {
      throw new ValidationError(`${key} must be a boolean`, { code: "invalid_settings" });
    }
    patch[key] = raw;
  }

  if ("githubCommentImageWidth" in record) {
    const value = record.githubCommentImageWidth;
    if (value === null) {
      patch.githubCommentImageWidth = null;
    } else if (value === "full") {
      patch.githubCommentImageWidth = "full";
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_IMAGE_WIDTH_MIN &&
      value <= COMMENT_IMAGE_WIDTH_MAX
    ) {
      patch.githubCommentImageWidth = value;
    } else {
      throw new ValidationError(
        `githubCommentImageWidth must be "full", an integer ${COMMENT_IMAGE_WIDTH_MIN}–${COMMENT_IMAGE_WIDTH_MAX}, or null`,
        { code: "invalid_settings", details: { field: "githubCommentImageWidth" } },
      );
    }
  }

  if ("githubCommentMaxInlineImages" in record) {
    const value = record.githubCommentMaxInlineImages;
    if (value === null) {
      patch.githubCommentMaxInlineImages = null;
    } else if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= COMMENT_MAX_INLINE_IMAGES_MIN &&
      value <= COMMENT_MAX_INLINE_IMAGES_MAX
    ) {
      patch.githubCommentMaxInlineImages = value;
    } else {
      throw new ValidationError(
        `githubCommentMaxInlineImages must be an integer ${COMMENT_MAX_INLINE_IMAGES_MIN}–${COMMENT_MAX_INLINE_IMAGES_MAX} or null`,
        { code: "invalid_settings", details: { field: "githubCommentMaxInlineImages" } },
      );
    }
  }

  if ("githubCommentNote" in record) {
    const value = record.githubCommentNote;
    if (value === null) {
      patch.githubCommentNote = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > NOTE_MAX_CHARS) {
        throw new ValidationError(
          `githubCommentNote must be 1–${NOTE_MAX_CHARS} characters after trimming`,
          { code: "invalid_settings", details: { field: "githubCommentNote" } },
        );
      }
      patch.githubCommentNote = trimmed;
    } else {
      throw new ValidationError("githubCommentNote must be a string or null", {
        code: "invalid_settings",
        details: { field: "githubCommentNote" },
      });
    }
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
      githubCommentRequireActorOnPr: record.githubCommentRequireActorOnPr ?? null,
      githubCommentImageWidth: record.githubCommentImageWidth ?? null,
      githubCommentMaxInlineImages: record.githubCommentMaxInlineImages ?? null,
      githubCommentNote: record.githubCommentNote ?? null,
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

/**
 * Response body shared by GET and PATCH /admin-ui/workspaces/:name/limits.
 *
 * `limits` used to echo the record's raw override fields (`?? null`),
 * which reads as "unlimited" for any self-serve workspace — those carry
 * `plan: "free"` with no explicit overrides, so every field was `null`
 * even though the free plan's defaults are enforced (issue #613 display
 * bug; enforcement via `resolveEffectiveLimits`/budget.ts was always
 * correct — only this projection lied). Mirrors `planResponse`'s shape
 * (`workspace-plan.ts`) so the two admin panels agree: `limits` is the
 * resolved effective value per field (null only when truly unlimited —
 * i.e. `plan` is undefined/legacy, or an explicit override clears it),
 * `overrides` lists which fields carry an explicit per-workspace override,
 * and `planApplied` says whether plan defaults were consulted at all.
 */
async function limitsResponse(env: Env, name: string, record: WorkspaceRecord) {
  const planApplied = record.plan !== undefined;
  const resolved = resolveEffectiveLimits(record);
  const overrides = LIMIT_FIELDS.filter(
    (field) => record[field as keyof WorkspacePlanLimits] !== undefined,
  );
  const limits = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, resolved[field as keyof WorkspacePlanLimits] ?? null]),
  ) as Record<(typeof LIMIT_FIELDS)[number], number | null>;
  let usage: { bytes: number; uploads: number } | null = null;
  try {
    const u = await getWorkspaceUsage(dbFor(env), name);
    usage = { bytes: u.bytes, uploads: u.uploadsInPeriod };
  } catch {
    usage = null;
  }
  return { workspace: name, planApplied, limits, overrides, usage };
}

/**
 * Response body shared by GET and PATCH /admin-ui/workspaces/:name/storage
 * (issue #583 Task 3.3). Wraps the same `storageStatusResponse` projection
 * `GET /me/workspaces/:name/storage` returns (never credential values, only
 * masked/presence fields — precedent noted on that function) and adds
 * `configuredBy`: the Better Auth user id that most recently ran the
 * self-serve save, useful to an operator investigating a workspace but not
 * something the self-serve UI itself needs to show.
 */
function adminStorageResponse(name: string, record: WorkspaceRecord) {
  return {
    workspace: name,
    ...storageStatusResponse(record, byoBucketAllowed(record)),
    configuredBy: record.storageConfiguredBy ?? null,
  };
}

/**
 * Validates the PATCH body for /admin-ui/workspaces/:name/storage — today
 * this route only flips the `byoBucketEnabled` gate (workspace.ts's
 * fail-closed BYO feature switch; issue #583 Task 1.3 notes this is the only
 * way to turn it on until self-serve opt-in ships). A single required
 * boolean, same posture as the boolean settings in
 * `validateGithubCommentSettingsPatch` above — no null-clear needed since
 * `false` already expresses "off".
 */
function validateByoBucketPatch(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object", {
      code: "invalid_storage_flag",
    });
  }
  const value = (body as Record<string, unknown>).byoBucketEnabled;
  if (typeof value !== "boolean") {
    throw new ValidationError("byoBucketEnabled must be a boolean", {
      code: "invalid_storage_flag",
    });
  }
  return value;
}

/**
 * Wire types for the `/admin-ui/*` responses, inferred from the serializers
 * above so the operator pages in apps/web (`src/pages/admin/*`) import the
 * shape they actually receive instead of re-declaring it. Type-only — nothing
 * here is imported at runtime across workers.
 */
export type AdminWorkspaceSummary = ReturnType<typeof workspaceSummaryResponse>;
export type AdminLimitsResponse = Awaited<ReturnType<typeof limitsResponse>>;
export type AdminPlanResponse = ReturnType<typeof planResponse> &
  Awaited<ReturnType<typeof adminSubscriptionInfo>>;
export type AdminStorageResponse = ReturnType<typeof adminStorageResponse>;
export type AdminGithubLink = ReturnType<typeof repoLinkResponse>;
export type { MetricsOverview } from "../metrics-overview";
export type { OrgInvite, OrgMember } from "../org-workspaces";
export type { OpenEnrollment } from "../auth-db";
/** `/admin-ui/oauth-clients*` passes the auth worker's body through unchanged. */
export type { SerializedOauthClient } from "@uploads/auth/oauth-client-serialize";

export const adminUi = new Hono<SessionVars>()
  .use("/*", sessionAuth, requireSessionUser, requireAdminUser)

  // Cached operator adoption-metrics overview (D1 rollups + auth-worker
  // signup history). `days` selects the window; only ALLOWED_WINDOWS are
  // accepted so the cache stays small. `fresh=1` bypasses the KV cache.
  .get("/metrics/overview", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? 30 : Number(raw);
    if (!ALLOWED_WINDOWS.includes(days as (typeof ALLOWED_WINDOWS)[number])) {
      throw new ValidationError(`days must be one of ${ALLOWED_WINDOWS.join(", ")}`, {
        code: "invalid_window",
      });
    }
    return c.json(await cachedOverview(c.env, days, c.req.query("fresh") === "1"));
  })

  // Analytics Engine upload breakdown by dimension (surface, content type,
  // client, repo). Additive and best-effort: an unconfigured or
  // unreachable Analytics Engine is a normal state the page renders as a
  // panel message, not an error — so this always returns 200.
  .get("/metrics/breakdown", async (c) => {
    const dimension = (c.req.query("dimension") ?? "surface") as BreakdownDimension;
    const days = Number(c.req.query("days") ?? 30);
    return c.json(await fetchBreakdown(c.env, dimension, Number.isFinite(days) ? days : 30));
  })

  // Slow-op trend (issue #812 tier 3): counts + p50/p95 wall ms per op name,
  // from the `uploads_slow_ops` Analytics Engine dataset written by
  // slow-op-analytics.ts's writeSlowOpPoint. Same additive/best-effort
  // contract as the breakdown panel above — always 200, an unconfigured or
  // unreachable Analytics Engine just renders as a panel message.
  .get("/metrics/slow-ops", async (c) => {
    const raw = c.req.query("window");
    const window: SlowOpWindow = raw === "7d" ? "7d" : "24h";
    return c.json(await fetchSlowOps(c.env, window));
  })

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
    const workspaces = names.map((name) => workspaceSummaryResponse(name, summaries.get(name)));
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
    if (!response.ok) throwForInviteError(response.status, payload);
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
    // Same existence rule as the sibling limits/plan/storage/settings edits —
    // a soft-deleted or purged-tombstone workspace 404s rather than minting a
    // live invite for a workspace that no longer serves.
    await loadEditableWorkspace(c.env, name);

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

    const enrollment = await createEnrollment(dbFor(c.env), {
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

  // Outstanding (unredeemed, unexpired) invite links for this workspace —
  // never includes the plaintext code (never stored) or its hash, so a
  // listed link's URL can't be reconstructed here; revoke and re-mint
  // instead.
  .get("/workspaces/:name/invite-links", async (c) => {
    const name = c.req.param("name");
    await loadEditableWorkspace(c.env, name);
    const links = await listOpenEnrollments(dbFor(c.env), name);
    return c.json({ links });
  })

  // Revoke one outstanding invite link before it's redeemed.
  .delete("/workspaces/:name/invite-links/:id", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    await loadEditableWorkspace(c.env, name);
    const id = c.req.param("id");
    const revoked = await revokeEnrollment(dbFor(c.env), name, id);
    if (!revoked) {
      throw new NotFoundError("invite link not found", { code: "invite_link_not_found" });
    }
    return c.json({ ok: true, id });
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
    // Body parsing and validation happen before the mutation so the
    // read-modify-write window stays as short as possible (issue #387).
    const record = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => {
        const next = { ...current };
        for (const field of LIMIT_FIELDS) {
          if (!(field in patch)) continue;
          const value = patch[field];
          if (value === null) delete next[field];
          else next[field] = value;
        }
        return next;
      },
      { requireServing: true },
    );
    return c.json(await limitsResponse(c.env, name, record));
  })

  // Read the workspace's plan, its availability, and resolved effective
  // limits (plan defaults backstopped by any explicit overrides).
  .get("/workspaces/:name/plan", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    const subscriptionInfo = await adminSubscriptionInfo(c.env, name, record);
    return c.json({ ...planResponse(name, record), ...subscriptionInfo });
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_plan" });
    }
    const { plan } = validatePlanPatch(body);
    const record = await mutateWorkspaceRecord(c.env, name, (current) => ({ ...current, plan }), {
      requireServing: true,
    });
    const subscriptionInfo = await adminSubscriptionInfo(c.env, name, record);
    return c.json({ ...planResponse(name, record), ...subscriptionInfo });
  })

  // Read the storage mode (shared/BYO), the `byoBucketEnabled` gate, and
  // configure/verify provenance (issue #583 Task 3.3). Same "presence
  // booleans/masked values only" posture as `GET /me/workspaces/:name/storage`
  // — never a credential value — plus `configuredBy` for operator triage.
  .get("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(adminStorageResponse(name, record));
  })

  // Flip the `byoBucketEnabled` feature gate — the only way a workspace gets
  // onto the BYO-bucket surface today (workspace.ts's `byoBucketAllowed`
  // doc comment: no self-serve opt-in exists yet). Same limits/plan PATCH
  // shape: rate-limited, read-modify-write via `mutateWorkspaceRecord`, 404 on
  // an unknown/soft-deleted workspace.
  .patch("/workspaces/:name/storage", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", {
        code: "invalid_storage_flag",
      });
    }
    const byoBucketEnabled = validateByoBucketPatch(body);
    const record = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => ({ ...current, byoBucketEnabled }),
      { requireServing: true },
    );
    return c.json(adminStorageResponse(name, record));
  })

  // Read the per-workspace managed-comment settings (file-page linking #304,
  // path/state metadata #365, image width / inline cap / note #307 / #535).
  .get("/workspaces/:name/settings", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(githubCommentSettingsResponse(name, record));
  })

  // Patch the managed-comment settings above. Omitted keys leave fields
  // unchanged; for the three #534 fields an explicit null clears. The whole
  // record is read-modify-written so other fields (limits, tokens, etc.)
  // survive untouched.
  .patch("/workspaces/:name/settings", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_settings" });
    }
    const patch = validateGithubCommentSettingsPatch(body);
    const record = await mutateWorkspaceRecord(
      c.env,
      name,
      (current) => {
        const next = { ...current };
        for (const key of GITHUB_COMMENT_BOOLEAN_KEYS) {
          if (key in patch) next[key] = patch[key];
        }
        if ("githubCommentImageWidth" in patch) {
          if (patch.githubCommentImageWidth === null) delete next.githubCommentImageWidth;
          else next.githubCommentImageWidth = patch.githubCommentImageWidth;
        }
        if ("githubCommentMaxInlineImages" in patch) {
          if (patch.githubCommentMaxInlineImages === null) delete next.githubCommentMaxInlineImages;
          else next.githubCommentMaxInlineImages = patch.githubCommentMaxInlineImages;
        }
        if ("githubCommentNote" in patch) {
          if (patch.githubCommentNote === null) delete next.githubCommentNote;
          else next.githubCommentNote = patch.githubCommentNote;
        }
        return next;
      },
      { requireServing: true },
    );
    return c.json(githubCommentSettingsResponse(name, record));
  })

  // Admin visibility (issue #318): the repos this workspace has claimed in
  // `github_repo_links`. Read-only — reassigning/removing a binding is the
  // dedicated /github-links routes below, which act on the repo (any
  // workspace), not scoped to one workspace's list.
  .get("/workspaces/:name/github-links", async (c) => {
    const name = c.req.param("name");
    const links = await listRepoLinksForWorkspace(dbFor(c.env), name);
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
    await setRepoLink(dbFor(c.env), repo, workspace, "admin");
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
    const before = await findRepoLinkStrict(dbFor(c.env), repo);
    if (!before) {
      return c.json({ repo, unlinked: false, reason: "not_linked" as const });
    }
    if (!(await allowWrite(c.env, before.workspaceName))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const removed = await deleteRepoLinkStrict(dbFor(c.env), repo);
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
      tokensRevoked = await revokeTokensForMintingUser(dbFor(c.env), userId);
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
  })

  // On-demand run of the hosted-host SVG/XML sandboxing-CSP probe (issue
  // #929) — the same sweep the daily cron runs (see index.ts's `scheduled`),
  // exposed so an operator can confirm a just-applied Transform Rule without
  // waiting for the next cron tick. Returns the fresh per-host records; each
  // is also persisted to REGISTRY, which is what `activeContentAllowed`
  // (../active-content.ts) reads.
  .post("/active-content/probe", async (c) => {
    const records = await runActiveContentHostSweep(c.env);
    return c.json({ records });
  });
