/**
 * Organizations are workspaces: apps/api grants session access to workspace
 * `X` through membership in the org whose slug is `X` (`org-workspaces.ts`).
 * Orgs are provisioned only by the internal routes (self-serve
 * `/internal/orgs/provision`, the ops backfill), which run apps/api's own
 * name and ownership checks first. The organization plugin's public
 * endpoints must not let a session create, re-slug, or delete an org behind
 * those checks.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

let db: FakeD1Database;
let orm: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  db = createFakeD1();
  orm = drizzle(db, { schema });
});

function dbEnv(): AuthEnv {
  return {
    DB: db,
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
  };
}

async function seedUser(id: string, role = "user"): Promise<void> {
  await orm.insert(schema.user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    role,
    banned: null,
    banReason: null,
    banExpires: null,
    cliOnboardedAt: null,
    stripeCustomerId: null,
    notifyMemberJoin: true,
    notifyUsageLimits: true,
  });
}

async function seedSession(userId: string, activeOrganizationId?: string): Promise<string> {
  const token = `sess-${crypto.randomUUID()}`;
  await orm.insert(schema.session).values({
    id: crypto.randomUUID(),
    userId,
    token,
    activeOrganizationId: activeOrganizationId ?? null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return token;
}

async function seedOwnedOrg(slug: string, ownerId: string): Promise<string> {
  const id = `org_${slug}`;
  await orm.insert(schema.organization).values({
    id,
    name: slug,
    slug,
    logo: null,
    createdAt: new Date(),
    metadata: null,
    stripeCustomerId: null,
  });
  await orm.insert(schema.member).values({
    id: `m_${slug}_${ownerId}`,
    organizationId: id,
    userId: ownerId,
    role: "owner",
    createdAt: new Date(),
  });
  return id;
}

function authPost(path: string, sessionToken: string, body: Record<string, unknown>) {
  return app.request(
    `/api/auth${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(body),
    },
    dbEnv(),
  );
}

async function orgBySlug(slug: string) {
  const [row] = await orm
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  return row ?? null;
}

describe("POST /organization/create", () => {
  it("rejects a signed-in user", async () => {
    await seedUser("u_alice");
    const session = await seedSession("u_alice");
    const res = await authPost("/organization/create", session, {
      name: "Some Workspace",
      slug: "some-workspace",
    });
    expect(res.status).toBe(403);
    expect(await orgBySlug("some-workspace")).toBeNull();
  });

  it("rejects a platform admin too — orgs come from the internal routes only", async () => {
    await seedUser("u_operator", "admin");
    const session = await seedSession("u_operator");
    const res = await authPost("/organization/create", session, {
      name: "Some Workspace",
      slug: "some-workspace",
    });
    expect(res.status).toBe(403);
    expect(await orgBySlug("some-workspace")).toBeNull();
  });
});

describe("POST /organization/update", () => {
  it("rejects an owner changing the slug", async () => {
    await seedUser("u_owner");
    const orgId = await seedOwnedOrg("acme", "u_owner");
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/update", session, {
      organizationId: orgId,
      data: { slug: "someone-elses-workspace" },
    });
    expect(res.status).toBe(400);
    expect(await orgBySlug("someone-elses-workspace")).toBeNull();
    expect(await orgBySlug("acme")).not.toBeNull();
  });

  it("rejects a slug change that targets the session's active org implicitly", async () => {
    await seedUser("u_owner");
    const orgId = await seedOwnedOrg("acme", "u_owner");
    const session = await seedSession("u_owner", orgId);
    const res = await authPost("/organization/update", session, {
      data: { slug: "someone-elses-workspace" },
    });
    expect(res.status).toBe(400);
    expect(await orgBySlug("acme")).not.toBeNull();
  });

  it("still lets an owner rename the display name", async () => {
    await seedUser("u_owner");
    const orgId = await seedOwnedOrg("acme", "u_owner");
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/update", session, {
      organizationId: orgId,
      data: { name: "Acme Inc" },
    });
    expect(res.status).toBe(200);
    expect((await orgBySlug("acme"))?.name).toBe("Acme Inc");
  });

  it("allows resubmitting the current slug unchanged", async () => {
    await seedUser("u_owner");
    const orgId = await seedOwnedOrg("acme", "u_owner");
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/update", session, {
      organizationId: orgId,
      data: { name: "Acme Inc", slug: "acme" },
    });
    expect(res.status).toBe(200);
    expect((await orgBySlug("acme"))?.name).toBe("Acme Inc");
  });
});

describe("POST /organization/delete", () => {
  it("rejects an owner deleting the org", async () => {
    await seedUser("u_owner");
    const orgId = await seedOwnedOrg("acme", "u_owner");
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/delete", session, { organizationId: orgId });
    expect(res.status).toBe(404);
    expect(await orgBySlug("acme")).not.toBeNull();
  });
});
