/**
 * Session-authenticated admin dashboard endpoints (plan D6/Phase 3 scope B).
 * Gated by `requireAdminUser` (Phase 2's session-based global admin auth,
 * NOT the `ADMIN_TOKEN` gating `/admin/*`) — distinct `/admin-ui/*` prefix so
 * the ops/CI `/admin` surface stays untouched. Backs the /admin page's
 * Workspaces slot on apps/web.
 */
import {
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { Hono } from "hono";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  createEnrollment,
  validateScopes,
} from "../auth-db";
import { allowWrite } from "../guards";
import { deriveWebOrigin, inviteLinkUrl } from "../invite-links";
import { membersForOrg, orgForWorkspace } from "../org-workspaces";
import {
  requireAdminUser,
  requireSessionUser,
  sessionAuth,
  type SessionVars,
} from "../session-auth";
import { getWorkspaceUsage } from "../usage";
import { isPurgedTombstone, loadWorkspaceRecordRaw, type WorkspaceRecord } from "../workspace";
import { LIMIT_FIELDS, validateLimitsPatch } from "../workspace-limits";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function orgSummaryForWorkspace(env: Env, name: string): Promise<OrgSummary | null> {
  const response = await env.AUTH.fetch(
    `https://auth.internal/internal/orgs/${encodeURIComponent(name)}`,
    { headers: { "x-uploads-internal": "1" } },
  );
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as OrgSummary | null;
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

    const workspaces = await Promise.all(
      names.map(async (name) => {
        const summary = await orgSummaryForWorkspace(c.env, name);
        return {
          workspace: name,
          organization: summary?.organization ?? null,
          memberCount: summary?.memberCount ?? 0,
          pendingInviteCount: summary?.pendingInviteCount ?? 0,
        };
      }),
    );
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

    const response = await c.env.AUTH.fetch(
      `https://auth.internal/internal/orgs/${encodeURIComponent(org.slug)}/invites`,
      { headers: { "x-uploads-internal": "1" } },
    );
    if (!response.ok) {
      throw new ValidationError("failed to list invites", {
        details: await response.json().catch(() => null),
      });
    }
    return c.json(await response.json());
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
    const record = await loadEditableWorkspace(c.env, name);
    const patch = validateLimitsPatch(await c.req.json().catch(() => ({})));
    for (const field of LIMIT_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      if (value === null) delete record[field];
      else record[field] = value;
    }
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(await limitsResponse(c.env, name, record));
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
  });
