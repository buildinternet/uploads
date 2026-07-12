/**
 * Session-authenticated admin dashboard endpoints (plan D6/Phase 3 scope B).
 * Gated by `requireAdminUser` (Phase 2's session-based global admin auth,
 * NOT the `ADMIN_TOKEN` gating `/admin/*`) — distinct `/admin-ui/*` prefix so
 * the ops/CI `/admin` surface stays untouched. Backs the /admin page's
 * Workspaces slot on apps/web.
 */
import { NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { allowWrite } from "../guards";
import { orgForWorkspace } from "../org-workspaces";
import {
  requireAdminUser,
  requireSessionUser,
  sessionAuth,
  type SessionVars,
} from "../session-auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    const response = await c.env.AUTH.fetch(
      `https://auth.internal/internal/orgs/${encodeURIComponent(org.slug)}/members`,
      { headers: { "x-uploads-internal": "1" } },
    );
    if (!response.ok) {
      throw new ValidationError("failed to list members", {
        details: await response.json().catch(() => null),
      });
    }
    return c.json(await response.json());
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
  });
