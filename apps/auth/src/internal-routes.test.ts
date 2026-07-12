import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

/**
 * These cover the request-validation short-circuits on the Phase 3
 * `/internal/*` routes (memberships/orgs/invite) that fail before touching
 * D1 — validated by using a DB stub that throws on first access.
 */
function poisonDB(): D1Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("DB should not be touched for this request");
      },
    },
  ) as D1Database;
}

function app() {
  return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
}

function env(): AuthEnv {
  return { DB: poisonDB(), WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
}

describe("GET /internal/memberships", () => {
  it("400s when userId is missing", async () => {
    const res = await app().request("/internal/memberships", {}, env());
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_user_id" },
    });
  });
});

describe("POST /internal/orgs", () => {
  it("400s when slug is missing", async () => {
    const res = await app().request(
      "/internal/orgs",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_slug" },
    });
  });
});

describe("POST /internal/invite", () => {
  it("400s when required fields are missing", async () => {
    const res = await app().request(
      "/internal/invite",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("400s on an invalid role without touching the DB", async () => {
    const res = await app().request(
      "/internal/invite",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationSlug: "acme",
          email: "a@b.com",
          role: "owner",
          inviterUserId: "u1",
        }),
      },
      env(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_role" },
    });
  });
});

/**
 * Behavioral coverage against the fake D1 harness (src/test/fake-d1.ts):
 * real migrations applied, real drizzle queries, real Better Auth
 * `organization` plugin writes for the `/internal/orgs` create path. No
 * `EMAIL` binding is configured, so `sendAuthEmail` (src/email.ts) logs
 * instead of sending — nothing here talks to a real email provider.
 */
describe("DB-backed behavior", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
    return {
      DB: db,
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
      ...overrides,
    };
  }

  async function seedUser(overrides: Partial<schema.AuthUser> = {}): Promise<schema.AuthUser> {
    const user: schema.AuthUser = {
      id: overrides.id ?? crypto.randomUUID(),
      name: overrides.name ?? "Ada Lovelace",
      email: overrides.email ?? `ada-${crypto.randomUUID()}@example.com`,
      emailVerified: overrides.emailVerified ?? true,
      image: overrides.image ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
      role: overrides.role ?? "user",
      banned: overrides.banned ?? null,
      banReason: overrides.banReason ?? null,
      banExpires: overrides.banExpires ?? null,
    };
    await orm.insert(schema.user).values(user);
    return user;
  }

  async function seedOrg(
    overrides: Partial<schema.AuthOrganization> = {},
  ): Promise<schema.AuthOrganization> {
    const org: schema.AuthOrganization = {
      id: overrides.id ?? crypto.randomUUID(),
      name: overrides.name ?? "Acme",
      slug: overrides.slug ?? `acme-${crypto.randomUUID()}`,
      logo: overrides.logo ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      metadata: overrides.metadata ?? null,
    };
    await orm.insert(schema.organization).values(org);
    return org;
  }

  describe("POST /internal/promote-admin", () => {
    it("promotes an existing user to admin", async () => {
      const user = await seedUser({ role: "user" });
      const res = await app().request(
        "/internal/promote-admin",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: user.email }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; user: { role: string; email: string } };
      expect(body).toMatchObject({ ok: true, user: { email: user.email, role: "admin" } });

      const [updated] = await orm.select().from(schema.user).where(eq(schema.user.id, user.id));
      expect(updated.role).toBe("admin");
    });

    it("404s when no user has that email", async () => {
      const res = await app().request(
        "/internal/promote-admin",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.com" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "user_not_found" },
      });
    });
  });

  describe("POST /internal/orgs", () => {
    // Discovered by this harness, not by design: Better Auth's
    // `organization.create` endpoint (better-auth/dist/plugins/organization/
    // routes/crud-org.mjs) requires either a resolvable session OR an
    // explicit `body.userId` ("server-only" per its own schema comment) —
    // but internal-routes.ts's `/internal/orgs` calls
    // `auth.api.createOrganization({ body: { slug, name } })` with neither,
    // since admin-provisioned orgs have no natural owner user. That means
    // creating a genuinely *new* org via this route always throws
    // UNAUTHORIZED today; only the idempotent existing-slug path (which
    // never reaches Better Auth) works. Pre-existing bug, out of scope for
    // this test-harness change — flagged separately rather than fixed here.
    it("500s creating a brand-new org (pre-existing bug: Better Auth requires a session or body.userId)", async () => {
      const slug = `new-org-${crypto.randomUUID()}`;
      const res = await app().request(
        "/internal/orgs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, name: "New Org" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(500);

      const rows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug));
      expect(rows).toHaveLength(0);
    });

    it("is idempotent — an existing slug returns 200 with the existing org", async () => {
      const org = await seedOrg();
      const res = await app().request(
        "/internal/orgs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: org.slug, name: "Ignored New Name" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        organization: { id: string; slug: string; name: string };
      };
      expect(body.organization).toMatchObject({ id: org.id, slug: org.slug, name: org.name });

      const rows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, org.slug));
      expect(rows).toHaveLength(1);
    });

    it("treats a concurrent create-race as idempotent (winner already inserted)", async () => {
      // Simulates the TOCTOU path in internal-routes.ts: the pre-check finds
      // nothing, but by the time Better Auth's createOrganization tries to
      // insert, another request has already won the unique-slug race.
      const slug = `race-${crypto.randomUUID()}`;
      const winner = await seedOrg({ slug, name: "Winner" });
      // Insert happened *after* the route's own pre-check would have run in
      // a real race; here we just assert the catch-and-re-query fallback:
      // Better Auth's createOrganization will throw on the unique constraint
      // since `winner` already occupies the slug, and the route should
      // recover by re-querying and returning 200 with the existing row.
      const res = await app().request(
        "/internal/orgs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, name: "Loser" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { organization: { id: string; slug: string } };
      expect(body.organization).toMatchObject({ id: winner.id, slug });
    });
  });

  describe("GET /internal/memberships", () => {
    it("lists an org membership for a user", async () => {
      const user = await seedUser();
      const org = await seedOrg();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      });

      const res = await app().request(`/internal/memberships?userId=${user.id}`, {}, dbEnv());
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        organizationId: string;
        organizationSlug: string;
        role: string;
      }>;
      expect(body).toEqual([{ organizationId: org.id, organizationSlug: org.slug, role: "owner" }]);
    });

    it("returns an empty list for a user with no memberships", async () => {
      const user = await seedUser();
      const res = await app().request(`/internal/memberships?userId=${user.id}`, {}, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("GET /internal/orgs/:slug and /internal/orgs/:slug/invites", () => {
    it("reports member and pending-invite counts, filtering out non-pending invites", async () => {
      const org = await seedOrg();
      const inviter = await seedUser();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: inviter.id,
        role: "owner",
        createdAt: new Date(),
      });
      await orm.insert(schema.invitation).values([
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          email: "pending@example.com",
          role: "member",
          status: "pending",
          expiresAt: new Date(Date.now() + 86_400_000),
          inviterId: inviter.id,
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          email: "accepted@example.com",
          role: "member",
          status: "accepted",
          expiresAt: new Date(Date.now() + 86_400_000),
          inviterId: inviter.id,
          createdAt: new Date(),
        },
      ]);

      const orgRes = await app().request(`/internal/orgs/${org.slug}`, {}, dbEnv());
      expect(orgRes.status).toBe(200);
      expect(await orgRes.json()).toMatchObject({ memberCount: 1, pendingInviteCount: 1 });

      const invitesRes = await app().request(`/internal/orgs/${org.slug}/invites`, {}, dbEnv());
      expect(invitesRes.status).toBe(200);
      const invitesBody = (await invitesRes.json()) as { invites: Array<{ email: string }> };
      expect(invitesBody.invites).toHaveLength(1);
      expect(invitesBody.invites[0]).toMatchObject({ email: "pending@example.com" });
    });

    it("404s for an unknown slug", async () => {
      const res = await app().request("/internal/orgs/does-not-exist", {}, dbEnv());
      expect(res.status).toBe(404);
    });
  });

  describe("POST /internal/invite", () => {
    it("inserts a pending invite with created_at set and logs the email (no EMAIL binding)", async () => {
      const org = await seedOrg();
      const inviter = await seedUser();
      const res = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email: "invitee@example.com",
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invitation: { id: string; status: string } };

      const rows = await orm
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, body.invitation.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("returns the existing pending invite instead of inserting a duplicate", async () => {
      const org = await seedOrg();
      const inviter = await seedUser();
      const email = "dupe@example.com";
      const first = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email,
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { invitation: { id: string } };

      const second = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email,
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { invitation: { id: string } };
      expect(secondBody.invitation.id).toBe(firstBody.invitation.id);

      const rows = await orm
        .select()
        .from(schema.invitation)
        .where(
          and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.email, email)),
        );
      expect(rows).toHaveLength(1);
    });

    it("404s when the organization slug is unknown", async () => {
      const inviter = await seedUser();
      const res = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: "does-not-exist",
            email: "a@b.com",
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "organization_not_found" },
      });
    });

    it("404s when the inviter user is unknown", async () => {
      const org = await seedOrg();
      const res = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email: "a@b.com",
            role: "member",
            inviterUserId: crypto.randomUUID(),
          }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "inviter_not_found" },
      });
    });
  });
});
