/**
 * `/internal/*` API (plan D1/D9) — reachable only via the `AUTH` service
 * binding from apps/api (see src/internal.ts's isInternalRequest guard,
 * applied in src/index.ts before this router is even reached).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthEnv } from "./auth";
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

    // Implementation choice: direct `organization` insert via drizzle, not
    // `auth.api.createOrganization`. The plugin's server method authorizes
    // off a Better Auth session (or an explicit userId) and makes the caller
    // the org's owner member — but these orgs are admin-provisioned with no
    // members at all (workspace backfill, invite flow provisioning), and
    // there is no session on a service-binding call. Same rationale as the
    // direct insert in POST /invite below.
    //
    // TOCTOU: two concurrent callers can both pass the `existing` check above
    // and race to create the same slug — the UNIQUE constraint stops the
    // loser. Treat that as "already exists" (re-query and return the winner's
    // row as 200) rather than propagating a 500 for what is really an
    // idempotent no-op from the caller's POV.
    const id = crypto.randomUUID();
    try {
      await db.insert(schema.organization).values({
        id,
        slug,
        name: name || slug,
        createdAt: new Date(),
      });
    } catch (err) {
      const [winner] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug))
        .limit(1);
      if (winner) {
        return c.json(
          { organization: { id: winner.id, slug: winner.slug, name: winner.name } },
          200,
        );
      }
      throw err;
    }
    return c.json({ organization: { id, slug, name: name || slug } }, 201);
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
      .where(
        and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.status, "pending")),
      );
    const pendingInvites = invites.length;
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
      .where(
        and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.status, "pending")),
      );
    return c.json({ invites: rows });
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

    // Authorization: either a global site operator (user.role === "admin") —
    // used by /admin-ui when the operator is not an org member of every
    // workspace — or an org member with role admin|owner. Unprivileged
    // callers (or a fabricated inviterUserId) must not create invites.
    const isGlobalAdmin = inviter.role === "admin";
    if (!isGlobalAdmin) {
      const [membership] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, inviter.id)))
        .limit(1);
      if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
        return c.json(
          errorJson(
            "inviter_not_authorized",
            "inviter must be a global admin or an org admin/owner",
          ),
          403,
        );
      }
    }

    // Normalize so "Ada@x.com" and "ada@x.com" hit the same pending row.
    const normalizedEmail = email.toLowerCase();
    const webOrigin = (c.env.WEB_ORIGIN || "https://uploads.sh").replace(/\/$/, "");
    const acceptUrlFor = (invitationId: string) => `${webOrigin}/accept-invitation/${invitationId}`;

    // Idempotency: an existing pending invite for this (org, email) is
    // returned as-is rather than inserting a duplicate row and re-sending
    // the invitation email (e.g. the admin double-clicks Invite).
    const [existingInvite] = await db
      .select()
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, org.id),
          eq(schema.invitation.email, normalizedEmail),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .limit(1);

    if (existingInvite) {
      return c.json(
        {
          invitation: {
            id: existingInvite.id,
            organizationId: existingInvite.organizationId,
            email: existingInvite.email,
            role: existingInvite.role,
            status: existingInvite.status,
            expiresAt: existingInvite.expiresAt,
          },
          // Always return so self-hosted (no EMAIL binding) can share the link.
          acceptUrl: acceptUrlFor(existingInvite.id),
        },
        200,
      );
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 days
    await db.insert(schema.invitation).values({
      id,
      organizationId: org.id,
      email: normalizedEmail,
      role,
      status: "pending",
      expiresAt,
      inviterId: inviter.id,
      createdAt: new Date(),
    });

    const acceptUrl = acceptUrlFor(id);
    await sendAuthEmail(c.env, {
      to: normalizedEmail,
      template: "invitation",
      context: {
        url: acceptUrl,
        organizationName: org.name,
        inviterEmail: inviter.email,
      },
    });

    return c.json(
      {
        invitation: {
          id,
          organizationId: org.id,
          email: normalizedEmail,
          role,
          status: "pending",
          expiresAt,
        },
        acceptUrl,
      },
      201,
    );
  })
  // Self-serve provisioning (spec 2026-07-14): create an org WITH the caller
  // as owner member, non-idempotent — a taken slug is a 409 the API surfaces
  // to the user, unlike POST /orgs (admin backfill, idempotent by design).
  .post("/orgs/provision", async (c) => {
    const body = await c.req
      .json<{ slug?: unknown; name?: unknown; ownerUserId?: unknown }>()
      .catch(() => ({}) as { slug?: unknown; name?: unknown; ownerUserId?: unknown });
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "";
    if (!slug || !ownerUserId) {
      return c.json(errorJson("invalid_request", "slug and ownerUserId are required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [owner] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, ownerUserId))
      .limit(1);
    if (!owner) {
      return c.json(errorJson("user_not_found", "no user with that id"), 404);
    }

    const [existing] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (existing) {
      return c.json(errorJson("slug_taken", "an organization with that slug already exists"), 409);
    }

    const id = crypto.randomUUID();
    try {
      await db.insert(schema.organization).values({
        id,
        slug,
        name: name || slug,
        createdAt: new Date(),
      });
    } catch (err) {
      // Re-query rather than assuming: a UNIQUE-constraint race with a
      // concurrent provision means a row now exists for this slug, and the
      // loser reports the same 409 the pre-check would have. Any other
      // insert failure (D1 outage, schema issue) leaves no such row — rethrow
      // it so it surfaces as a 500 instead of a misleading "slug taken".
      const [winner] = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug))
        .limit(1);
      if (winner) {
        return c.json(
          errorJson("slug_taken", "an organization with that slug already exists"),
          409,
        );
      }
      throw err;
    }
    try {
      await db.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: id,
        userId: owner.id,
        role: "owner",
        createdAt: new Date(),
      });
    } catch (err) {
      // Compensating delete: the fake-D1 test harness (and D1 itself, for
      // this call shape) doesn't support drizzle's db.batch, so the org and
      // owner-member inserts aren't atomic. If the member insert fails,
      // delete the just-inserted org row rather than leaving an orphaned
      // org/slug with no members, then rethrow so this surfaces as a 500.
      await db.delete(schema.organization).where(eq(schema.organization.id, id));
      throw err;
    }
    return c.json({ organization: { id, slug, name: name || slug } }, 201);
  })
  // Compensating action for self-serve provisioning: roll back an org whose
  // KV workspace write failed. Refuses orgs that have grown past their sole
  // owner so it can never be used to destroy a real team.
  .delete("/orgs/:slug", async (c) => {
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
    if (members.length > 1) {
      return c.json(errorJson("org_not_empty", "organization has more than one member"), 409);
    }
    await db.delete(schema.member).where(eq(schema.member.organizationId, org.id));
    await db.delete(schema.organization).where(eq(schema.organization.id, org.id));
    return c.json({ ok: true });
  })
  // Self-serve gate: does this user have a linked GitHub account?
  .get("/users/:id/github-linked", async (c) => {
    const userId = c.req.param("id");
    const db = drizzle(c.env.DB, { schema });
    const [row] = await db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
      .limit(1);
    return c.json({ githubLinked: Boolean(row) });
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
