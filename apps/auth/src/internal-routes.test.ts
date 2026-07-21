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
      cliOnboardedAt: overrides.cliOnboardedAt ?? null,
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
    // The success path below only exists because of the direct-insert fix
    // (PR #99): the original implementation went through Better Auth's
    // `createOrganization`, which requires a session or `body.userId` and
    // threw UNAUTHORIZED on every genuinely new org — a bug this harness
    // surfaced when it was first written.
    it("creates a brand-new org (201) with the row inserted and created_at set", async () => {
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
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        organization: { id: string; slug: string; name: string };
      };
      expect(body.organization).toMatchObject({ slug, name: "New Org" });

      const rows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(body.organization.id);
      expect(rows[0].name).toBe("New Org");
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("defaults name to the slug when name is omitted", async () => {
      const slug = `nameless-${crypto.randomUUID()}`;
      const res = await app().request(
        "/internal/orgs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { organization: { name: string } };
      expect(body.organization.name).toBe(slug);
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

    it("treats a concurrent create-race as idempotent (loser recovers via catch-and-re-query)", async () => {
      // Genuinely exercises the TOCTOU catch path in internal-routes.ts:
      // the route's pre-check SELECT is made to see an empty table (as if
      // the winner hadn't inserted yet), the winner's row is injected right
      // after, and the route's direct INSERT then hits the UNIQUE slug
      // constraint — it must recover by re-querying and returning 200 with
      // the winner's row instead of propagating a 500.
      const slug = `race-${crypto.randomUUID()}`;
      const winner = { id: crypto.randomUUID(), slug, name: "Winner" };
      const realPrepare = db.prepare.bind(db);
      let raceArmed = true;
      db.prepare = ((sql: string) => {
        const stmt = realPrepare(sql);
        if (raceArmed && /select/i.test(sql) && sql.includes(`"organization"`)) {
          raceArmed = false;
          // Empty pre-check result, then the winner lands before the insert.
          const emptied = Object.create(stmt) as typeof stmt;
          emptied.bind = (...params: unknown[]) => {
            db.__sqlite
              .prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
              .run(winner.id, winner.name, winner.slug, Date.now());
            const bound = stmt.bind(...params);
            return Object.assign(Object.create(bound), {
              all: async () => ({ success: true, results: [], meta: {} }),
              raw: async () => [],
            });
          };
          return emptied;
        }
        return stmt;
      }) as typeof db.prepare;

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

      // Only the winner's row exists — the loser's insert was rejected.
      const rows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Winner");
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
        organizationName: string;
        role: string;
      }>;
      expect(body).toEqual([
        {
          organizationId: org.id,
          organizationSlug: org.slug,
          organizationName: org.name,
          role: "owner",
        },
      ]);
    });

    it("filters to a single org when slug is provided", async () => {
      const user = await seedUser();
      const acme = await seedOrg({ slug: "acme", name: "Acme" });
      const beta = await seedOrg({ slug: "beta", name: "Beta" });
      await orm.insert(schema.member).values([
        {
          id: crypto.randomUUID(),
          organizationId: acme.id,
          userId: user.id,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId: beta.id,
          userId: user.id,
          role: "member",
          createdAt: new Date(),
        },
      ]);

      const res = await app().request(
        `/internal/memberships?userId=${user.id}&slug=acme`,
        {},
        dbEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          organizationId: acme.id,
          organizationSlug: "acme",
          organizationName: "Acme",
          role: "owner",
        },
      ]);
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

  describe("GET /internal/orgs/summaries", () => {
    it("returns every org with aggregated member and pending-invite counts", async () => {
      const acme = await seedOrg({ slug: "acme", name: "Acme" });
      const beta = await seedOrg({ slug: "beta", name: "Beta" });
      const user = await seedUser();
      await orm.insert(schema.member).values([
        {
          id: crypto.randomUUID(),
          organizationId: acme.id,
          userId: user.id,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId: beta.id,
          userId: user.id,
          role: "member",
          createdAt: new Date(),
        },
      ]);
      await orm.insert(schema.invitation).values({
        id: crypto.randomUUID(),
        organizationId: acme.id,
        email: "pending@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: user.id,
        createdAt: new Date(),
      });

      const res = await app().request("/internal/orgs/summaries", {}, dbEnv());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        organizations: Array<{
          organization: { slug: string };
          memberCount: number;
          pendingInviteCount: number;
        }>;
      };
      const bySlug = new Map(body.organizations.map((row) => [row.organization.slug, row]));
      expect(bySlug.get("acme")).toMatchObject({ memberCount: 1, pendingInviteCount: 1 });
      expect(bySlug.get("beta")).toMatchObject({ memberCount: 1, pendingInviteCount: 0 });
    });
  });

  describe("POST /internal/invite", () => {
    async function seedOrgAdmin(
      role: "owner" | "admin" | "member" = "owner",
    ): Promise<{ org: schema.AuthOrganization; inviter: schema.AuthUser }> {
      const org = await seedOrg();
      const inviter = await seedUser();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: inviter.id,
        role,
        createdAt: new Date(),
      });
      return { org, inviter };
    }

    it("inserts a pending invite with created_at set and logs the email (no EMAIL binding)", async () => {
      const { org, inviter } = await seedOrgAdmin("owner");
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
      const body = (await res.json()) as {
        invitation: { id: string; status: string; email: string };
        acceptUrl: string;
        emailConfigured: boolean;
      };
      expect(body.acceptUrl).toContain(`/accept-invitation/${body.invitation.id}`);
      expect(body.invitation.email).toBe("invitee@example.com");
      // Test env has no EMAIL binding, so the install reports it can't email.
      expect(body.emailConfigured).toBe(false);

      const rows = await orm
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, body.invitation.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it("allows a global site admin to invite without org membership", async () => {
      const org = await seedOrg();
      const inviter = await seedUser({ role: "admin" });
      const res = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email: "ops@example.com",
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(201);
    });

    it("403s when the inviter is only an org member", async () => {
      const { org, inviter } = await seedOrgAdmin("member");
      const res = await app().request(
        "/internal/invite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationSlug: org.slug,
            email: "nope@example.com",
            role: "member",
            inviterUserId: inviter.id,
          }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "inviter_not_authorized" },
      });
    });

    it("returns the existing pending invite instead of inserting a duplicate", async () => {
      const { org, inviter } = await seedOrgAdmin("admin");
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
      const inviter = await seedUser({ role: "admin" });
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

  describe("POST /internal/orgs/provision", () => {
    it("creates the org and seeds an owner member", async () => {
      const user = await seedUser({ id: "u1", email: "a@x.com" });
      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "zachbot", ownerUserId: user.id }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        organization: { id: string; slug: string; name: string };
      };
      expect(body.organization.slug).toBe("zachbot");

      const rows = await orm
        .select()
        .from(schema.member)
        .where(eq(schema.member.organizationId, body.organization.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: user.id, role: "owner" });
    });

    it("409s when the slug already exists", async () => {
      const org = await seedOrg({ slug: "zachbot" });
      const user = await seedUser();
      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: org.slug, ownerUserId: user.id }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "slug_taken" },
      });
    });

    it("404s for an unknown ownerUserId", async () => {
      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: `new-${crypto.randomUUID()}`, ownerUserId: "no-such-user" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "user_not_found" },
      });
    });

    it("400s when slug or ownerUserId is missing", async () => {
      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "only-slug" }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "invalid_request" },
      });
    });

    it("treats a concurrent create-race as slug_taken (real UNIQUE-race re-query)", async () => {
      // Same shape as the /internal/orgs race test above: the pre-check
      // SELECT is made to see an empty table, a winner row is injected right
      // after, and the route's INSERT then hits the UNIQUE slug constraint.
      // The catch handler must re-query, find the winner row, and report the
      // same 409 the pre-check would have — not a 500.
      const user = await seedUser();
      const slug = `race-${crypto.randomUUID()}`;
      const winner = { id: crypto.randomUUID(), slug, name: "Winner" };
      const realPrepare = db.prepare.bind(db);
      let raceArmed = true;
      db.prepare = ((sql: string) => {
        const stmt = realPrepare(sql);
        if (raceArmed && /select/i.test(sql) && sql.includes(`"organization"`)) {
          raceArmed = false;
          const emptied = Object.create(stmt) as typeof stmt;
          emptied.bind = (...params: unknown[]) => {
            db.__sqlite
              .prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
              .run(winner.id, winner.name, winner.slug, Date.now());
            const bound = stmt.bind(...params);
            return Object.assign(Object.create(bound), {
              all: async () => ({ success: true, results: [], meta: {} }),
              raw: async () => [],
            });
          };
          return emptied;
        }
        return stmt;
      }) as typeof db.prepare;

      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, ownerUserId: user.id }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "slug_taken" },
      });

      // Only the winner's row exists — the loser's insert was rejected, and
      // no member row was seeded for the loser's owner.
      const rows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Winner");
    });

    it("rethrows (surfacing as a 500) when the insert fails for a reason other than a slug race", async () => {
      // Simulates a genuine D1 failure (outage, schema issue, etc.) rather
      // than a UNIQUE-constraint race: the INSERT throws but no row for the
      // slug ever lands, so the catch handler's re-query comes back empty
      // and it must rethrow instead of misreporting 409 slug_taken.
      const user = await seedUser();
      const slug = `insert-fails-${crypto.randomUUID()}`;
      const realPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const stmt = realPrepare(sql);
        if (/insert/i.test(sql) && sql.includes(`"organization"`)) {
          const broken = Object.create(stmt) as typeof stmt;
          broken.bind = (...params: unknown[]) => {
            const bound = stmt.bind(...params);
            return Object.assign(Object.create(bound), {
              run: async () => {
                throw new Error("simulated D1 outage");
              },
              all: async () => {
                throw new Error("simulated D1 outage");
              },
            });
          };
          return broken;
        }
        return stmt;
      }) as typeof db.prepare;

      // Hono's fetch-style app.request() catches thrown errors at the top
      // level rather than rejecting, so the observable effect of "rethrow
      // instead of misreporting slug_taken" is a 500 (Hono's default error
      // response), not a 409.
      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, ownerUserId: user.id }),
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

    it("deletes the org row (compensating delete) when the owner-member insert fails", async () => {
      // The fake-D1 test harness doesn't support drizzle's db.batch, so the
      // org and owner-member inserts aren't atomic — if the member insert
      // fails, the route must delete the just-inserted org row rather than
      // leaving an orphaned org/slug with no members, and rethrow (500).
      const user = await seedUser();
      const slug = `member-insert-fails-${crypto.randomUUID()}`;
      const realPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const stmt = realPrepare(sql);
        if (/insert/i.test(sql) && sql.includes(`"member"`)) {
          const broken = Object.create(stmt) as typeof stmt;
          broken.bind = (...params: unknown[]) => {
            const bound = stmt.bind(...params);
            return Object.assign(Object.create(bound), {
              run: async () => {
                throw new Error("simulated D1 outage");
              },
              all: async () => {
                throw new Error("simulated D1 outage");
              },
            });
          };
          return broken;
        }
        return stmt;
      }) as typeof db.prepare;

      const res = await app().request(
        "/internal/orgs/provision",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, ownerUserId: user.id }),
        },
        dbEnv(),
      );
      expect(res.status).toBe(500);

      const orgRows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug));
      expect(orgRows).toHaveLength(0);
    });
  });

  describe("DELETE /internal/orgs/:slug", () => {
    it("deletes an org with a single (owner) member and its member rows", async () => {
      const org = await seedOrg();
      const user = await seedUser();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      });

      const res = await app().request(`/internal/orgs/${org.slug}`, { method: "DELETE" }, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const orgRows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, org.id));
      expect(orgRows).toHaveLength(0);
      const memberRows = await orm
        .select()
        .from(schema.member)
        .where(eq(schema.member.organizationId, org.id));
      expect(memberRows).toHaveLength(0);
    });

    it("409s when the org has more than one member", async () => {
      const org = await seedOrg();
      const user1 = await seedUser();
      const user2 = await seedUser();
      await orm.insert(schema.member).values([
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: user1.id,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: user2.id,
          role: "member",
          createdAt: new Date(),
        },
      ]);

      const res = await app().request(`/internal/orgs/${org.slug}`, { method: "DELETE" }, dbEnv());
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "org_not_empty" },
      });
    });

    it("404s for an unknown slug", async () => {
      const res = await app().request(
        "/internal/orgs/does-not-exist",
        { method: "DELETE" },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "organization_not_found" },
      });
    });

    it("force=1 bypasses org_not_empty and deletes a multi-member org (#250)", async () => {
      const org = await seedOrg();
      const user1 = await seedUser();
      const user2 = await seedUser();
      await orm.insert(schema.member).values([
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: user1.id,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          userId: user2.id,
          role: "member",
          createdAt: new Date(),
        },
      ]);

      const res = await app().request(
        `/internal/orgs/${org.slug}?force=1`,
        { method: "DELETE" },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const orgRows = await orm
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, org.id));
      expect(orgRows).toHaveLength(0);
      const memberRows = await orm
        .select()
        .from(schema.member)
        .where(eq(schema.member.organizationId, org.id));
      expect(memberRows).toHaveLength(0);
    });

    it("deletes a single-member org named similarly to 'default'", async () => {
      const org = await seedOrg({ slug: "default-staging" });
      const user = await seedUser();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      });

      const res = await app().request(`/internal/orgs/${org.slug}`, { method: "DELETE" }, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe("GET /internal/orgs (#250 orphan sweep listing)", () => {
    it("returns every org's id and slug", async () => {
      const org1 = await seedOrg();
      const org2 = await seedOrg();

      const res = await app().request("/internal/orgs", {}, dbEnv());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { organizations: { id: string; slug: string }[] };
      const slugs = body.organizations.map((o) => o.slug);
      expect(slugs).toEqual(expect.arrayContaining([org1.slug, org2.slug]));
    });

    it("returns an empty list shape when there are no orgs", async () => {
      const res = await app().request("/internal/orgs", {}, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ organizations: [] });
    });
  });

  describe("GET /internal/users/:id/github-linked", () => {
    it("true when an account row with providerId github exists", async () => {
      const user = await seedUser({ id: "u1" });
      await orm.insert(schema.account).values({
        id: crypto.randomUUID(),
        userId: user.id,
        accountId: "999",
        providerId: "github",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app().request(`/internal/users/${user.id}/github-linked`, {}, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ githubLinked: true });
    });

    it("false otherwise (including unknown user)", async () => {
      const user = await seedUser();
      const res = await app().request(`/internal/users/${user.id}/github-linked`, {}, dbEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ githubLinked: false });

      const unknownRes = await app().request(
        `/internal/users/${crypto.randomUUID()}/github-linked`,
        {},
        dbEnv(),
      );
      expect(unknownRes.status).toBe(200);
      expect(await unknownRes.json()).toEqual({ githubLinked: false });
    });
  });

  describe("DELETE /internal/orgs/:slug/invites/:id", () => {
    async function seed(actorRole: string) {
      const org = await seedOrg();
      const actor = await seedUser({ id: "u_actor", email: "actor@x.com" });
      await orm.insert(schema.member).values({
        id: "m_actor",
        organizationId: org.id,
        userId: actor.id,
        role: actorRole,
        createdAt: new Date(),
      });
      const inviteId = "inv_1";
      await orm.insert(schema.invitation).values({
        id: inviteId,
        organizationId: org.id,
        email: "invitee@x.com",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86400000),
        inviterId: actor.id,
        createdAt: new Date(),
      });
      return { org, actor, inviteId };
    }

    it("revokes a pending invite for an admin actor", async () => {
      const { org, actor, inviteId } = await seed("admin");
      const res = await app().request(
        `/internal/orgs/${org.slug}/invites/${inviteId}?actorUserId=${actor.id}`,
        { method: "DELETE" },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const rows = await orm
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, inviteId));
      expect(rows).toHaveLength(0);
    });

    it("403s when the actor is only a member", async () => {
      const { org, actor, inviteId } = await seed("member");
      const res = await app().request(
        `/internal/orgs/${org.slug}/invites/${inviteId}?actorUserId=${actor.id}`,
        { method: "DELETE" },
        dbEnv(),
      );
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "actor_not_authorized" },
      });
    });

    it("404s for an unknown invite id", async () => {
      const { org, actor } = await seed("owner");
      const res = await app().request(
        `/internal/orgs/${org.slug}/invites/nope?actorUserId=${actor.id}`,
        { method: "DELETE" },
        dbEnv(),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "invite_not_found" },
      });
    });
  });

  describe("DELETE /internal/orgs/:slug/members/:memberId", () => {
    async function seed() {
      const org = await seedOrg();
      const owner = await seedUser({ id: "u_owner", email: "owner@x.com" });
      const admin = await seedUser({ id: "u_admin", email: "admin@x.com" });
      const admin2 = await seedUser({ id: "u_admin2", email: "admin2@x.com" });
      const member = await seedUser({ id: "u_member", email: "member@x.com" });
      const rows = [
        { id: "m_owner", userId: owner.id, role: "owner" },
        { id: "m_admin", userId: admin.id, role: "admin" },
        { id: "m_admin2", userId: admin2.id, role: "admin" },
        { id: "m_member", userId: member.id, role: "member" },
      ];
      for (const r of rows) {
        await orm.insert(schema.member).values({
          id: r.id,
          organizationId: org.id,
          userId: r.userId,
          role: r.role,
          createdAt: new Date(),
        });
      }
      return { org, owner, admin, admin2, member };
    }
    const del = (slug: string, memberId: string, actorUserId: string) =>
      app().request(
        `/internal/orgs/${slug}/members/${memberId}?actorUserId=${actorUserId}`,
        { method: "DELETE" },
        dbEnv(),
      );

    it("lets an admin remove a member", async () => {
      const { org, admin } = await seed();
      const res = await del(org.slug, "m_member", admin.id);
      expect(res.status).toBe(200);
      const rows = await orm.select().from(schema.member).where(eq(schema.member.id, "m_member"));
      expect(rows).toHaveLength(0);
    });
    it("forbids an admin removing another admin", async () => {
      const { org, admin } = await seed();
      const res = await del(org.slug, "m_admin2", admin.id);
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "actor_not_authorized" },
      });
    });
    it("lets an owner remove an admin", async () => {
      const { org, owner } = await seed();
      const res = await del(org.slug, "m_admin", owner.id);
      expect(res.status).toBe(200);
    });
    it("never removes an owner", async () => {
      // Actor is admin (not owner) here so this exercises the
      // owner-protection check specifically, rather than colliding with the
      // self-removal check (which fires first per the brief's ordering and
      // is covered separately by "blocks removing yourself" below) —
      // the brief's verbatim test used owner-as-actor here, which is
      // actually self-removal of the owner and would hit cannot_modify_self
      // (400) before ever reaching the owner-protection branch.
      const { org, admin } = await seed();
      const res = await del(org.slug, "m_owner", admin.id);
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "cannot_modify_owner" },
      });
    });
    it("blocks removing yourself", async () => {
      const { org, admin } = await seed();
      const res = await del(org.slug, "m_admin", admin.id);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "cannot_modify_self" },
      });
    });
    it("404s for an unknown member id", async () => {
      const { org, owner } = await seed();
      const res = await del(org.slug, "nope", owner.id);
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "member_not_found" },
      });
    });
  });

  describe("PATCH /internal/orgs/:slug/members/:memberId", () => {
    async function seed() {
      const org = await seedOrg();
      const owner = await seedUser({ id: "u_owner", email: "owner@x.com" });
      const admin = await seedUser({ id: "u_admin", email: "admin@x.com" });
      const admin2 = await seedUser({ id: "u_admin2", email: "admin2@x.com" });
      const member = await seedUser({ id: "u_member", email: "member@x.com" });
      const rows = [
        { id: "m_owner", userId: owner.id, role: "owner" },
        { id: "m_admin", userId: admin.id, role: "admin" },
        { id: "m_admin2", userId: admin2.id, role: "admin" },
        { id: "m_member", userId: member.id, role: "member" },
      ];
      for (const r of rows) {
        await orm.insert(schema.member).values({
          id: r.id,
          organizationId: org.id,
          userId: r.userId,
          role: r.role,
          createdAt: new Date(),
        });
      }
      return { org, owner, admin, admin2, member };
    }
    const patch = (slug: string, memberId: string, actorUserId: string, role: string) =>
      app().request(
        `/internal/orgs/${slug}/members/${memberId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actorUserId, role }),
        },
        dbEnv(),
      );

    it("lets an owner promote a member to admin", async () => {
      const { org, owner } = await seed();
      const res = await patch(org.slug, "m_member", owner.id, "admin");
      expect(res.status).toBe(200);
      expect((await res.json()) as { member: { role: string } }).toMatchObject({
        member: { id: "m_member", role: "admin" },
      });
      const [row] = await orm.select().from(schema.member).where(eq(schema.member.id, "m_member"));
      expect(row.role).toBe("admin");
    });
    it("forbids an admin changing roles", async () => {
      const { org, admin } = await seed();
      const res = await patch(org.slug, "m_member", admin.id, "admin");
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "actor_not_authorized" },
      });
    });
    it("rejects an invalid target role", async () => {
      const { org, owner } = await seed();
      const res = await patch(org.slug, "m_member", owner.id, "owner");
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "invalid_role" },
      });
    });
    // Brief correction (identical flaw to Task 2's "never removes an owner"
    // test): the brief's verbatim version has the OWNER act on their own
    // member row, which hits the self-check (400 cannot_modify_self) before
    // ever reaching the owner-protection branch — so it doesn't actually
    // exercise cannot_modify_owner. Using an admin actor targeting the owner
    // row instead reaches the owner-protection check. Self-protection is
    // separately covered by "blocks changing your own role" below.
    it("never modifies an owner", async () => {
      const { org, admin } = await seed();
      const res = await patch(org.slug, "m_owner", admin.id, "member");
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "cannot_modify_owner" },
      });
    });
    it("blocks changing your own role", async () => {
      const { org, admin } = await seed();
      const res = await patch(org.slug, "m_admin", admin.id, "member");
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "cannot_modify_self" },
      });
    });
    it("is idempotent when the role is unchanged", async () => {
      const { org, owner } = await seed();
      const res = await patch(org.slug, "m_admin", owner.id, "admin");
      expect(res.status).toBe(200);
      expect((await res.json()) as { member: { role: string } }).toMatchObject({
        member: { role: "admin" },
      });
    });
  });
});
