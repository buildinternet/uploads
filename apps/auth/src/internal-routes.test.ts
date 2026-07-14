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
      };
      expect(body.acceptUrl).toContain(`/accept-invitation/${body.invitation.id}`);
      expect(body.invitation.email).toBe("invitee@example.com");

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
});
