/**
 * `/internal/*` API (plan D1/D9) — reachable only via the `AUTH` service
 * binding from apps/api (see src/internal.ts's isInternalRequest guard,
 * applied in src/index.ts before this router is even reached).
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAuth, type AuthEnv } from "./auth";
import { sendAuthEmail } from "./email";
import * as schema from "./schema";

function errorJson(code: string, message: string) {
  return { error: { code, message } } as const;
}

export const internal = new Hono<{ Bindings: AuthEnv }>()
  // Phase 3 (plan scope A): memberships for a user, used by
  // apps/api/src/org-workspaces.ts and the admin-ui endpoints to resolve
  // "what orgs/workspaces can this user act on".
  .get("/memberships", async (c) => {
    const userId = c.req.query("userId")?.trim();
    if (!userId) {
      return c.json(errorJson("invalid_user_id", "userId is required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const rows = await db
      .select({
        organizationId: schema.member.organizationId,
        organizationSlug: schema.organization.slug,
        role: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, userId));

    return c.json(rows);
  })
  // Phase 3 (plan scope A): admin-provisioned org creation, idempotent on
  // slug — the backfill script (apps/api/scripts/backfill-orgs.mjs) and
  // apps/api's /admin/orgs/backfill both call this per KV workspace.
  .post("/orgs", async (c) => {
    const body = await c.req
      .json<{ slug?: unknown; name?: unknown }>()
      .catch(() => ({}) as { slug?: unknown; name?: unknown });
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!slug) {
      return c.json(errorJson("invalid_slug", "slug is required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [existing] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (existing) {
      return c.json(
        { organization: { id: existing.id, slug: existing.slug, name: existing.name } },
        200,
      );
    }

    const auth = await createAuth(c.env);
    if (!auth) {
      return c.json(errorJson("auth_unavailable", "Auth is not configured yet."), 503);
    }
    const created = await auth.api.createOrganization({
      body: { slug, name: name || slug },
    });
    if (!created) {
      return c.json(errorJson("create_failed", "failed to create organization"), 500);
    }
    return c.json(
      { organization: { id: created.id, slug: created.slug, name: created.name } },
      201,
    );
  })
  // Phase 3 (plan scope B): org lookup + member/invite counts for
  // GET /admin-ui/workspaces on apps/api.
  .get("/orgs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const members = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    const invites = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(eq(schema.invitation.organizationId, org.id));
    const pendingInvites = invites.length; // status filtering happens client-side today; see /invites below for detail
    return c.json({
      organization: { id: org.id, slug: org.slug, name: org.name },
      memberCount: members.length,
      pendingInviteCount: pendingInvites,
    });
  })
  // Phase 3 (plan scope B): member list for GET /admin-ui/workspaces/:name/members.
  .get("/orgs/:slug/members", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const rows = await db
      .select({
        id: schema.member.id,
        role: schema.member.role,
        userId: schema.user.id,
        email: schema.user.email,
        name: schema.user.name,
        createdAt: schema.member.createdAt,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(eq(schema.member.organizationId, org.id));
    return c.json({ members: rows });
  })
  // Phase 3 (plan scope B): pending invites for the admin-ui workspace detail view.
  .get("/orgs/:slug/invites", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const rows = await db
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        role: schema.invitation.role,
        status: schema.invitation.status,
        expiresAt: schema.invitation.expiresAt,
      })
      .from(schema.invitation)
      .where(eq(schema.invitation.organizationId, org.id));
    return c.json({ invites: rows.filter((r) => r.status === "pending") });
  })
  // Phase 3 (plan scope B): server-side invite creation for
  // POST /admin-ui/workspaces/:name/invites on apps/api.
  //
  // Implementation choice: this writes the `invitation` row directly via
  // drizzle (same pattern as promote-admin above) and sends the email itself,
  // rather than calling the organization plugin's `auth.api.createInvitation`
  // server method. That method authorizes the *inviter* off a Better Auth
  // session it resolves from request headers/cookies — but this route is
  // reached from apps/api's requireAdminUser (session-based *global* admin
  // auth, Phase 2), not an org-membership session, and there is no
  // browser-forwarded Better Auth session token that maps to "is this admin
  // an owner/admin of this org" (admins provision orgs, they aren't
  // necessarily members of every one). Re-deriving a synthetic session to
  // satisfy the plugin's own authorization would be more fragile than just
  // inserting the row this route is already trusted (service-binding +
  // requireAdminUser upstream) to create.
  .post("/invite", async (c) => {
    const body = await c.req
      .json<{
        organizationSlug?: unknown;
        email?: unknown;
        role?: unknown;
        inviterUserId?: unknown;
      }>()
      .catch(
        () =>
          ({}) as {
            organizationSlug?: unknown;
            email?: unknown;
            role?: unknown;
            inviterUserId?: unknown;
          },
      );
    const organizationSlug =
      typeof body.organizationSlug === "string" ? body.organizationSlug.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "member";
    const inviterUserId = typeof body.inviterUserId === "string" ? body.inviterUserId.trim() : "";
    if (!organizationSlug || !email || !inviterUserId) {
      return c.json(
        errorJson("invalid_request", "organizationSlug, email, and inviterUserId are required"),
        400,
      );
    }
    if (role !== "member" && role !== "admin") {
      return c.json(errorJson("invalid_role", "role must be member or admin"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, organizationSlug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const [inviter] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, inviterUserId))
      .limit(1);
    if (!inviter) {
      return c.json(errorJson("inviter_not_found", "no user with that id"), 404);
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
    await db.insert(schema.invitation).values({
      id,
      organizationId: org.id,
      email,
      role,
      status: "pending",
      expiresAt,
      inviterId: inviter.id,
    });

    const webOrigin = c.env.WEB_ORIGIN || "https://uploads.sh";
    await sendAuthEmail(c.env, {
      to: email,
      template: "invitation",
      context: {
        url: `${webOrigin}/accept-invitation/${id}`,
        organizationName: org.name,
        inviterEmail: inviter.email,
      },
    });

    return c.json(
      { invitation: { id, organizationId: org.id, email, role, status: "pending", expiresAt } },
      201,
    );
  })
  // D9 fallback: ADMIN_TOKEN-gated promote endpoint on apps/api proxies here.
  // Looked up by email since that's the only identifier ops/CI reliably has;
  // 404s (rather than a generic 400) if no such user has ever signed in.
  .post("/promote-admin", async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      return c.json(errorJson("invalid_email", "email is required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [existing] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!existing) {
      return c.json(errorJson("user_not_found", "no user with that email"), 404);
    }

    await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, existing.id));
    const [updated] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, existing.id))
      .limit(1);

    return c.json({
      ok: true,
      user: { id: updated.id, email: updated.email, role: updated.role },
    });
  });
