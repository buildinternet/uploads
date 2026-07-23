/**
 * `/internal/*` API (plan D1/D9) — reachable only via the `AUTH` service
 * binding from apps/api (see src/internal.ts's isInternalRequest guard,
 * applied in src/index.ts before this router is even reached).
 */
import { isStripeBackingStatus } from "@uploads/billing";
import { drizzle } from "drizzle-orm/d1";
import { and, count, countDistinct, eq, gt, isNull, max } from "drizzle-orm";
import { Hono } from "hono";
import { OAUTH_SCOPES, type AuthEnv } from "./auth";
import { sendAuthEmail } from "./email";
import { memberCapDenial } from "./member-cap";
import * as schema from "./schema";

function errorJson(code: string, message: string) {
  return { error: { code, message } } as const;
}

/** The actor's org-scoped role, or null if they aren't a member of this org. */
async function actorRole(
  db: ReturnType<typeof drizzle<typeof schema>>,
  orgId: string,
  actorUserId: string,
): Promise<string | null> {
  if (!actorUserId) return null;
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actorUserId)))
    .limit(1);
  return row?.role ?? null;
}

/** A target member row (id/userId/role) scoped to the org, or null if none. */
async function loadTargetMember(
  db: ReturnType<typeof drizzle<typeof schema>>,
  orgId: string,
  memberId: string,
): Promise<{ id: string; userId: string; role: string } | null> {
  const [row] = await db
    .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Shared matrix for remove + role-change on a loaded target:
 * owner|admin may act on members; only owners may act on other admins;
 * owner rows and self are never manageable.
 * Returns an errorJson payload + status, or null when allowed.
 */
function memberManageDenied(
  actorOrgRole: string | null,
  target: { userId: string; role: string },
  actorUserId: string,
): { status: 400 | 403; body: ReturnType<typeof errorJson> } | null {
  if (target.userId === actorUserId) {
    return {
      status: 400,
      body: errorJson("cannot_modify_self", "you cannot modify yourself"),
    };
  }
  if (target.role === "owner") {
    return {
      status: 403,
      body: errorJson("cannot_modify_owner", "the workspace owner cannot be modified"),
    };
  }
  if (actorOrgRole !== "owner" && actorOrgRole !== "admin") {
    return {
      status: 403,
      body: errorJson("actor_not_authorized", "actor must be an org admin or owner"),
    };
  }
  if (target.role === "admin" && actorOrgRole !== "owner") {
    return {
      status: 403,
      body: errorJson("actor_not_authorized", "only an owner can manage an admin"),
    };
  }
  return null;
}

// Lane 1 (operator OAuth admin panel contract, .context/2026-07-18-oauth-admin-panel-contract.md):
// validation error shape differs from the rest of this file's errorJson —
// the contract locks in `{error:"invalid_request", message}` for these routes.
function invalidRequest(message: string) {
  return { error: "invalid_request", message } as const;
}

/** Same shape as invalidRequest, but with a distinct error code for a specific condition. */
function officialClientError(message: string) {
  return { error: "official_client", message } as const;
}

const REDIRECT_SCHEME_ALLOWLIST = new Set(["https:", "http:"]);

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Validates a redirect/homepage/icon URL per the contract's scheme allowlist. */
function isAllowedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!REDIRECT_SCHEME_ALLOWLIST.has(url.protocol)) return false;
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return false;
  return true;
}

/** Redirect URIs additionally forbid a fragment component (RFC 6749 §3.1.2). */
function isAllowedRedirectUrl(value: string): boolean {
  if (!isAllowedUrl(value)) return false;
  const url = new URL(value);
  return url.hash === "";
}

type OauthClientRow = typeof schema.oauthClient.$inferSelect;

/** Reads the `official` flag out of the client's metadata JSON blob. */
function isOfficial(row: OauthClientRow): boolean {
  const metadata = row.metadata as Record<string, unknown> | null;
  return Boolean(metadata && metadata.official === true);
}

function toEpochMs(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : value;
}

type OauthClientStats = {
  consentCount: number;
  activeTokenCount: number;
  lastConsentAt: number | null;
};

async function statsForClient(
  db: ReturnType<typeof drizzle<typeof schema>>,
  clientId: string,
): Promise<OauthClientStats> {
  const [consentRow] = await db
    .select({
      consentCount: countDistinct(schema.oauthConsent.userId),
      lastConsentAt: max(schema.oauthConsent.createdAt),
    })
    .from(schema.oauthConsent)
    .where(eq(schema.oauthConsent.clientId, clientId));
  const [tokenRow] = await db
    .select({ activeTokenCount: count() })
    .from(schema.oauthRefreshToken)
    .where(
      and(
        eq(schema.oauthRefreshToken.clientId, clientId),
        isNull(schema.oauthRefreshToken.revoked),
        gt(schema.oauthRefreshToken.expiresAt, new Date()),
      ),
    );
  return {
    consentCount: consentRow?.consentCount ?? 0,
    activeTokenCount: tokenRow?.activeTokenCount ?? 0,
    lastConsentAt: toEpochMs(consentRow?.lastConsentAt ?? null),
  };
}

function serializeClient(row: OauthClientRow, stats: OauthClientStats) {
  return {
    clientId: row.clientId,
    name: row.name,
    type: row.type,
    public: Boolean(row.public),
    disabled: Boolean(row.disabled),
    official: isOfficial(row),
    redirectUris: row.redirectUris ?? [],
    scopes: row.scopes ?? [],
    uri: row.uri,
    icon: row.icon,
    userId: row.userId,
    skipConsent: Boolean(row.skipConsent),
    createdAt: toEpochMs(row.createdAt),
    updatedAt: toEpochMs(row.updatedAt),
    ...stats,
  };
}

function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

function validateRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const uris: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isAllowedRedirectUrl(entry)) return null;
    uris.push(entry);
  }
  return uris;
}

function validateScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(OAUTH_SCOPES as readonly string[]).includes(entry)) {
      return null;
    }
    scopes.push(entry);
  }
  return scopes;
}

/** Optional https(-or-loopback) URL field (uri/icon). Undefined = "not provided". */
function validateOptionalUrl(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !isAllowedUrl(value)) return { ok: false };
  return { ok: true, value };
}

export const internal = new Hono<{ Bindings: AuthEnv }>()
  // Memberships for a user (org-workspaces + member-gated /me routes).
  // Optional `slug` → one-org authz lookup (LIMIT 1; bills one match).
  .get("/memberships", async (c) => {
    const userId = c.req.query("userId")?.trim();
    if (!userId) {
      return c.json(errorJson("invalid_user_id", "userId is required"), 400);
    }
    const slug = c.req.query("slug")?.trim() || undefined;

    const db = drizzle(c.env.DB, { schema });
    const conditions = [eq(schema.member.userId, userId)];
    if (slug) conditions.push(eq(schema.organization.slug, slug));

    const query = db
      .select({
        organizationId: schema.member.organizationId,
        organizationSlug: schema.organization.slug,
        organizationName: schema.organization.name,
        role: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(and(...conditions));

    const rows = slug ? await query.limit(1) : await query;
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
  // #250 orphan-org sweep: every org slug, for apps/api's retention sweep to
  // cross-reference against `ws:<slug>` KV keys. id+slug is all the sweep
  // needs — it never touches org name/timestamps.
  .get("/orgs", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const rows = await db
      .select({
        id: schema.organization.id,
        slug: schema.organization.slug,
        createdAt: schema.organization.createdAt,
      })
      .from(schema.organization);
    return c.json({ organizations: rows });
  })
  // Admin list: all org member/pending-invite counts in 3 queries (not N×3).
  // Registered before `/orgs/:slug` so "summaries" is not parsed as a slug.
  .get("/orgs/summaries", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const [orgs, memberRows, inviteRows] = await Promise.all([
      db
        .select({
          id: schema.organization.id,
          slug: schema.organization.slug,
          name: schema.organization.name,
        })
        .from(schema.organization),
      db
        .select({
          organizationId: schema.member.organizationId,
          memberCount: count(),
        })
        .from(schema.member)
        .groupBy(schema.member.organizationId),
      db
        .select({
          organizationId: schema.invitation.organizationId,
          pendingInviteCount: count(),
        })
        .from(schema.invitation)
        .where(eq(schema.invitation.status, "pending"))
        .groupBy(schema.invitation.organizationId),
    ]);

    const membersByOrg = new Map(memberRows.map((row) => [row.organizationId, row.memberCount]));
    const invitesByOrg = new Map(
      inviteRows.map((row) => [row.organizationId, row.pendingInviteCount]),
    );

    return c.json({
      organizations: orgs.map((org) => ({
        organization: { id: org.id, slug: org.slug, name: org.name },
        memberCount: membersByOrg.get(org.id) ?? 0,
        pendingInviteCount: invitesByOrg.get(org.id) ?? 0,
      })),
    });
  })
  // Phase 3 (plan scope B): org lookup + member/invite counts for
  // single-workspace admin detail / orgForWorkspace.
  .get("/orgs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select({
        id: schema.organization.id,
        slug: schema.organization.slug,
        name: schema.organization.name,
      })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    // COUNT aggregates (not id lists + .length) so only the count crosses the wire.
    const [[memberRow], [inviteRow]] = await Promise.all([
      db
        .select({ memberCount: count() })
        .from(schema.member)
        .where(eq(schema.member.organizationId, org.id)),
      db
        .select({ pendingInviteCount: count() })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.organizationId, org.id),
            eq(schema.invitation.status, "pending"),
          ),
        ),
    ]);
    return c.json({
      organization: { id: org.id, slug: org.slug, name: org.name },
      memberCount: memberRow?.memberCount ?? 0,
      pendingInviteCount: inviteRow?.pendingInviteCount ?? 0,
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
  // Issue #445 (task 1/2): the Stripe subscription (if any) backing an org's
  // plan, for apps/api's /me billing surface and the admin panel's
  // subscription view. `referenceId` on the `subscription` table (Task 1's
  // schema, stripe-plugin.ts's `organization: { enabled: true }`) is the org
  // id — a Better Auth org can in principle have accumulated more than one
  // subscription row across its lifetime (upgrade/downgrade/re-subscribe), so
  // this picks the single most relevant one rather than assuming exactly one
  // row: an active/trialing/past_due row wins over a terminal one (those are
  // the statuses stripe-plugin.ts's `desiredPlanForStatus` still treats as
  // "pro"), and ties within a priority bucket break on the latest
  // `periodEnd` (falling back to `trialEnd`, since a trialing row may have no
  // `periodEnd` yet).
  .get("/orgs/:slug/subscription", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }

    const rows = await db
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.referenceId, org.id));

    const rank = (status: string | null) => (isStripeBackingStatus(status) ? 0 : 1);
    const sortKey = (row: (typeof rows)[number]) =>
      row.periodEnd?.getTime() ?? row.trialEnd?.getTime() ?? 0;
    const best = rows.sort((a, b) => {
      const rankDiff = rank(a.status) - rank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return sortKey(b) - sortKey(a);
    })[0];

    if (!best) {
      return c.json({ subscription: null });
    }
    return c.json({
      subscription: {
        status: best.status ?? "incomplete",
        periodEnd: best.periodEnd ? best.periodEnd.toISOString() : null,
        cancelAtPeriodEnd: Boolean(best.cancelAtPeriodEnd),
        stripeCustomerId: best.stripeCustomerId ?? null,
        plan: best.plan,
      },
    });
  })
  // Task 1 (#275): admin/owner-authorized revocation of a pending invite,
  // used by the workspace people tab's pending-invite management.
  .delete("/orgs/:slug/invites/:id", async (c) => {
    const slug = c.req.param("slug");
    const inviteId = c.req.param("id");
    const requestActorUserId = c.req.query("actorUserId") ?? "";
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    // Actor and invite lookups are independent; the authz check still gates
    // before the not-found check below.
    const [role, [invite]] = await Promise.all([
      actorRole(db, org.id, requestActorUserId),
      db
        .select({ id: schema.invitation.id })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.id, inviteId),
            eq(schema.invitation.organizationId, org.id),
            eq(schema.invitation.status, "pending"),
          ),
        )
        .limit(1),
    ]);
    if (role !== "owner" && role !== "admin") {
      return c.json(errorJson("actor_not_authorized", "actor must be an org admin or owner"), 403);
    }
    if (!invite) {
      return c.json(errorJson("invite_not_found", "no pending invite with that id"), 404);
    }
    await db.delete(schema.invitation).where(eq(schema.invitation.id, invite.id));
    return c.json({ ok: true });
  })
  // Task 2 (#275): member removal — matrix in memberManageDenied().
  .delete("/orgs/:slug/members/:memberId", async (c) => {
    const slug = c.req.param("slug");
    const memberId = c.req.param("memberId");
    const requestActorUserId = c.req.query("actorUserId") ?? "";
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const [target, role] = await Promise.all([
      loadTargetMember(db, org.id, memberId),
      actorRole(db, org.id, requestActorUserId),
    ]);
    if (!target) {
      return c.json(errorJson("member_not_found", "no member with that id in this org"), 404);
    }
    const denied = memberManageDenied(role, target, requestActorUserId);
    if (denied) return c.json(denied.body, denied.status);
    await db.delete(schema.member).where(eq(schema.member.id, target.id));
    return c.json({ ok: true });
  })
  // Task 3 (#275): member role change (admin↔member) — same matrix as remove.
  .patch("/orgs/:slug/members/:memberId", async (c) => {
    const slug = c.req.param("slug");
    const memberId = c.req.param("memberId");
    const body = await c.req
      .json<{ actorUserId?: unknown; role?: unknown }>()
      .catch(() => ({}) as { actorUserId?: unknown; role?: unknown });
    const requestActorUserId = typeof body.actorUserId === "string" ? body.actorUserId : "";
    const nextRole = typeof body.role === "string" ? body.role.trim() : "";
    if (nextRole !== "admin" && nextRole !== "member") {
      return c.json(errorJson("invalid_role", "role must be admin or member"), 400);
    }
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const [target, role] = await Promise.all([
      loadTargetMember(db, org.id, memberId),
      actorRole(db, org.id, requestActorUserId),
    ]);
    if (!target) {
      return c.json(errorJson("member_not_found", "no member with that id in this org"), 404);
    }
    const denied = memberManageDenied(role, target, requestActorUserId);
    if (denied) return c.json(denied.body, denied.status);
    if (target.role !== nextRole) {
      await db.update(schema.member).set({ role: nextRole }).where(eq(schema.member.id, target.id));
    }
    return c.json({ member: { id: target.id, userId: target.userId, role: nextRole } });
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
          emailConfigured: Boolean(c.env.EMAIL),
        },
        200,
      );
    }

    // Member cap (issue #450), checked only past the idempotent early return
    // above: re-inviting an already-pending email consumes no new seat, so a
    // workspace sitting exactly at its cap must still be able to re-issue the
    // link for an invite it already sent.
    const denial = await memberCapDenial(c.env, db, {
      organizationId: org.id,
      organizationSlug: org.slug,
      inviterIsGlobalAdmin: isGlobalAdmin,
    });
    if (denial) return c.json(errorJson(denial.code, denial.message), 403);

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
        // Binding presence, not delivery confirmation — sendAuthEmail is
        // fire-and-forget. Lets clients say "emailed" vs "share this link".
        emailConfigured: Boolean(c.env.EMAIL),
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
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    const [memberCountRow] = await db
      .select({ memberCount: count() })
      .from(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    if ((memberCountRow?.memberCount ?? 0) > 1 && !force) {
      return c.json(errorJson("org_not_empty", "organization has more than one member"), 409);
    }
    await db.delete(schema.member).where(eq(schema.member.organizationId, org.id));
    await db.delete(schema.organization).where(eq(schema.organization.id, org.id));
    return c.json({ ok: true });
  })
  // Uploader attribution (issue #340): the user's linked GitHub account id
  // (numeric, as a string — Better Auth stores provider account ids as TEXT),
  // or null when no GitHub account is linked. The api worker resolves this to
  // a login via the GitHub API and caches it.
  .get("/users/:id/github-account", async (c) => {
    const userId = c.req.param("id");
    const db = drizzle(c.env.DB, { schema });
    const [row] = await db
      .select({ accountId: schema.account.accountId })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
      .limit(1);
    return c.json({ githubAccountId: row?.accountId ?? null });
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
  })
  // Lane 1 (operator OAuth admin panel contract): operator CRUD over
  // Better Auth's oauth-provider tables. Always creates/keeps a public PKCE
  // client — no client-secret handling anywhere in this file.
  .get("/oauth-clients", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const rows = await db.select().from(schema.oauthClient).orderBy(schema.oauthClient.createdAt);
    // orderBy asc by default; contract wants createdAt desc.
    rows.reverse();

    // Grouped aggregates instead of statsForClient() per row (avoids N+1).
    const [consentRows, tokenRows] = await Promise.all([
      db
        .select({
          clientId: schema.oauthConsent.clientId,
          consentCount: countDistinct(schema.oauthConsent.userId),
          lastConsentAt: max(schema.oauthConsent.createdAt),
        })
        .from(schema.oauthConsent)
        .groupBy(schema.oauthConsent.clientId),
      db
        .select({
          clientId: schema.oauthRefreshToken.clientId,
          activeTokenCount: count(),
        })
        .from(schema.oauthRefreshToken)
        .where(
          and(
            isNull(schema.oauthRefreshToken.revoked),
            gt(schema.oauthRefreshToken.expiresAt, new Date()),
          ),
        )
        .groupBy(schema.oauthRefreshToken.clientId),
    ]);
    const consentByClient = new Map(consentRows.map((row) => [row.clientId, row]));
    const tokensByClient = new Map(tokenRows.map((row) => [row.clientId, row.activeTokenCount]));

    const clients = rows.map((row) => {
      const consent = consentByClient.get(row.clientId);
      const stats: OauthClientStats = {
        consentCount: consent?.consentCount ?? 0,
        activeTokenCount: tokensByClient.get(row.clientId) ?? 0,
        lastConsentAt: toEpochMs(consent?.lastConsentAt ?? null),
      };
      return serializeClient(row, stats);
    });
    return c.json({ clients });
  })
  .get("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    const db = drizzle(c.env.DB, { schema });
    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }
    const stats = await statsForClient(db, clientId);
    return c.json(serializeClient(row, stats));
  })
  .post("/oauth-clients", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

    const name = validateName(body.name);
    if (!name) {
      return c.json(invalidRequest("name is required and must be ≤ 200 characters"), 400);
    }
    const redirectUris = validateRedirectUris(body.redirectUris);
    if (!redirectUris) {
      return c.json(
        invalidRequest("redirectUris must be 1-20 valid http(s) URLs (http only for loopback)"),
        400,
      );
    }
    const scopes = validateScopes(body.scopes);
    if (!scopes) {
      return c.json(invalidRequest("scopes must be a non-empty subset of OAUTH_SCOPES"), 400);
    }
    const uriResult = validateOptionalUrl(body.uri);
    if (!uriResult.ok) {
      return c.json(invalidRequest("uri must be a valid https (or loopback http) URL"), 400);
    }
    const iconResult = validateOptionalUrl(body.icon);
    if (!iconResult.ok) {
      return c.json(invalidRequest("icon must be a valid https (or loopback http) URL"), 400);
    }
    const type = typeof body.type === "string" && body.type ? body.type : "web";
    const official = body.official === true;

    const db = drizzle(c.env.DB, { schema });
    const clientId = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.oauthClient).values({
      id: crypto.randomUUID(),
      clientId,
      clientSecret: null,
      name,
      icon: iconResult.value,
      uri: uriResult.value,
      redirectUris,
      scopes,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      type,
      public: true,
      requirePKCE: true,
      disabled: false,
      skipConsent: false,
      userId: null,
      metadata: official ? { official: true } : null,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    const stats = await statsForClient(db, clientId);
    return c.json(serializeClient(row, stats), 201);
  })
  .patch("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    const db = drizzle(c.env.DB, { schema });
    const [existing] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    if (!existing) {
      return c.json({ error: "not_found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const updates: Partial<OauthClientRow> = {};

    if ("name" in body) {
      const name = validateName(body.name);
      if (!name) {
        return c.json(invalidRequest("name is required and must be ≤ 200 characters"), 400);
      }
      updates.name = name;
    }
    if ("redirectUris" in body) {
      const redirectUris = validateRedirectUris(body.redirectUris);
      if (!redirectUris) {
        return c.json(
          invalidRequest("redirectUris must be 1-20 valid http(s) URLs (http only for loopback)"),
          400,
        );
      }
      updates.redirectUris = redirectUris;
    }
    if ("scopes" in body) {
      const scopes = validateScopes(body.scopes);
      if (!scopes) {
        return c.json(invalidRequest("scopes must be a non-empty subset of OAUTH_SCOPES"), 400);
      }
      updates.scopes = scopes;
    }
    if ("uri" in body) {
      const uriResult = validateOptionalUrl(body.uri);
      if (!uriResult.ok) {
        return c.json(invalidRequest("uri must be a valid https (or loopback http) URL"), 400);
      }
      updates.uri = uriResult.value;
    }
    if ("icon" in body) {
      const iconResult = validateOptionalUrl(body.icon);
      if (!iconResult.ok) {
        return c.json(invalidRequest("icon must be a valid https (or loopback http) URL"), 400);
      }
      updates.icon = iconResult.value;
    }
    if ("disabled" in body) {
      if (typeof body.disabled !== "boolean") {
        return c.json(invalidRequest("disabled must be a boolean"), 400);
      }
      updates.disabled = body.disabled;
    }
    if ("skipConsent" in body) {
      if (typeof body.skipConsent !== "boolean") {
        return c.json(invalidRequest("skipConsent must be a boolean"), 400);
      }
      updates.skipConsent = body.skipConsent;
    }
    if ("official" in body) {
      if (typeof body.official !== "boolean") {
        return c.json(invalidRequest("official must be a boolean"), 400);
      }
      const metadata = { ...(existing.metadata as Record<string, unknown> | null) };
      if (body.official) {
        metadata.official = true;
      } else {
        delete metadata.official;
      }
      updates.metadata = Object.keys(metadata).length > 0 ? metadata : null;
    }

    updates.updatedAt = new Date();
    await db
      .update(schema.oauthClient)
      .set(updates)
      .where(eq(schema.oauthClient.clientId, clientId));

    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    const stats = await statsForClient(db, clientId);
    return c.json(serializeClient(row, stats));
  })
  .delete("/oauth-clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    const db = drizzle(c.env.DB, { schema });
    const [existing] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    if (!existing) {
      return c.json({ error: "not_found" }, 404);
    }
    if (isOfficial(existing)) {
      return c.json(
        officialClientError(
          "official clients cannot be deleted; remove the official flag first (PATCH official:false)",
        ),
        409,
      );
    }

    // Atomic via D1 batch — a partial failure must not leave tokens/consents
    // orphaned against a deleted client (or vice versa).
    await db.batch([
      db.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.clientId, clientId)),
      db.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.clientId, clientId)),
      db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.clientId, clientId)),
      db.delete(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)),
    ]);

    return c.json({ ok: true });
  });
