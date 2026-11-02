/**
 * Workspace API tokens (`auth_tokens`, minted by POST /v1/tokens with a
 * `minting_user_id`) must stop working once their minter loses the
 * membership (or role) that let them mint. apps/api's bearer auth resolves
 * the token row and never re-checks membership, so revocation has to happen
 * at every place a `member` row is deleted or demoted:
 *
 * - `DELETE /internal/orgs/:slug/members/:memberId` (apps/api's admin remove)
 * - `PATCH  /internal/orgs/:slug/members/:memberId` (apps/api's role change)
 * - Better Auth's own `/organization/remove-member`, `/organization/leave`,
 *   and `/organization/update-member-role`, reachable with a session.
 *
 * `auth_tokens` lives in the same D1 database as this worker's tables, and
 * the fake D1 applies apps/api's migrations, so these tests read the real
 * column shape.
 */
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import { internal } from "./internal-routes";
import { isWorkspaceManagerRole } from "./member-tokens";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

let db: FakeD1Database;
let orm: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  db = createFakeD1();
  orm = drizzle(db, { schema });
});

/** `/internal/*` is service-binding-only in prod; mount it bare like internal-routes.test.ts. */
const internalApp = new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);

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

async function seedSession(userId: string): Promise<string> {
  const token = `sess-${crypto.randomUUID()}`;
  await orm.insert(schema.session).values({
    id: crypto.randomUUID(),
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return token;
}

async function seedOrg(slug: string): Promise<string> {
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
  return id;
}

async function seedMember(id: string, orgId: string, userId: string, role: string) {
  await orm.insert(schema.member).values({
    id,
    organizationId: orgId,
    userId,
    role,
    createdAt: new Date(),
  });
}

const FILE_SCOPES = ["files:read", "files:write", "files:delete"];

async function seedToken(
  id: string,
  workspace: string,
  mintingUserId: string | null,
  opts: { scopes?: string[]; revokedAt?: string } = {},
) {
  await db
    .prepare(
      `INSERT INTO auth_tokens
         (id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at, minting_user_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      workspace,
      `hash-${id}`,
      JSON.stringify(opts.scopes ?? FILE_SCOPES),
      "2026-09-01T00:00:00.000Z",
      opts.revokedAt ?? null,
      mintingUserId,
    )
    .run();
}

async function revokedAt(id: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT revoked_at FROM auth_tokens WHERE id = ?`)
    .bind(id)
    .first<{ revoked_at: string | null }>();
  return row?.revoked_at ?? null;
}

/**
 * acme: owner u_owner, admin u_admin, member u_member. u_member is also a
 * member of beta. Tokens:
 *   t_member_acme      — u_member, acme (the one removal should revoke)
 *   t_member_acme_gov  — u_member, acme, carries workspace:invite
 *   t_member_beta      — u_member, beta (other workspace: must survive)
 *   t_admin_acme       — u_admin, acme, file-only
 *   t_admin_acme_gov   — u_admin, acme, workspace:invite
 *   t_legacy_acme      — null minting_user_id (must always survive)
 *   t_member_old       — u_member, acme, already revoked earlier
 */
async function seedWorld() {
  for (const id of ["u_owner", "u_admin", "u_member"]) await seedUser(id);
  const acme = await seedOrg("acme");
  const beta = await seedOrg("beta");
  await seedMember("m_owner", acme, "u_owner", "owner");
  await seedMember("m_admin", acme, "u_admin", "admin");
  await seedMember("m_member", acme, "u_member", "member");
  await seedMember("m_member_beta", beta, "u_member", "member");
  await seedToken("t_member_acme", "acme", "u_member");
  await seedToken("t_member_acme_gov", "acme", "u_member", {
    scopes: [...FILE_SCOPES, "workspace:invite"],
  });
  await seedToken("t_member_beta", "beta", "u_member");
  await seedToken("t_admin_acme", "acme", "u_admin");
  await seedToken("t_admin_acme_gov", "acme", "u_admin", {
    scopes: ["workspace:invite"],
  });
  await seedToken("t_legacy_acme", "acme", null);
  await seedToken("t_member_old", "acme", "u_member", {
    revokedAt: "2026-09-02T00:00:00.000Z",
  });
  return { acme, beta };
}

async function expectOnlyMemberAcmeRevoked() {
  expect(await revokedAt("t_member_acme")).not.toBeNull();
  expect(await revokedAt("t_member_acme_gov")).not.toBeNull();
  expect(await revokedAt("t_member_beta")).toBeNull();
  expect(await revokedAt("t_admin_acme")).toBeNull();
  expect(await revokedAt("t_admin_acme_gov")).toBeNull();
  expect(await revokedAt("t_legacy_acme")).toBeNull();
  // An earlier revocation keeps its original timestamp.
  expect(await revokedAt("t_member_old")).toBe("2026-09-02T00:00:00.000Z");
}

async function expectNothingRevoked() {
  for (const id of [
    "t_member_acme",
    "t_member_acme_gov",
    "t_member_beta",
    "t_admin_acme",
    "t_admin_acme_gov",
    "t_legacy_acme",
  ]) {
    expect(await revokedAt(id)).toBeNull();
  }
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

describe("member removal revokes the removed member's tokens for that workspace", () => {
  it("DELETE /internal/orgs/:slug/members/:memberId", async () => {
    await seedWorld();
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_member?actorUserId=u_admin`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    await expectOnlyMemberAcmeRevoked();
  });

  it("a denied internal removal revokes nothing", async () => {
    await seedWorld();
    // Admins can't remove the owner.
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_owner?actorUserId=u_admin`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(403);
    await expectNothingRevoked();
  });

  it("Better Auth /organization/remove-member", async () => {
    const { acme } = await seedWorld();
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/remove-member", session, {
      memberIdOrEmail: "m_member",
      organizationId: acme,
    });
    expect(res.status).toBe(200);
    await expectOnlyMemberAcmeRevoked();
  });

  it("Better Auth /organization/leave", async () => {
    const { acme } = await seedWorld();
    const session = await seedSession("u_member");
    const res = await authPost("/organization/leave", session, { organizationId: acme });
    expect(res.status).toBe(200);
    await expectOnlyMemberAcmeRevoked();
  });

  it("a rejected /organization/leave (sole owner) revokes nothing", async () => {
    const { acme } = await seedWorld();
    await seedToken("t_owner_acme", "acme", "u_owner");
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/leave", session, { organizationId: acme });
    expect(res.status).toBe(400);
    expect(await revokedAt("t_owner_acme")).toBeNull();
    await expectNothingRevoked();
  });
});

describe("demotion out of admin revokes the member's workspace-governance tokens", () => {
  it("PATCH /internal/orgs/:slug/members/:memberId admin → member", async () => {
    await seedWorld();
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_admin`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorUserId: "u_owner", role: "member" }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    // workspace:* needs admin/owner at mint time — revoked. File-only kept.
    expect(await revokedAt("t_admin_acme_gov")).not.toBeNull();
    expect(await revokedAt("t_admin_acme")).toBeNull();
    expect(await revokedAt("t_member_acme_gov")).toBeNull();
  });

  it("promotion revokes nothing", async () => {
    await seedWorld();
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_member`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorUserId: "u_owner", role: "admin" }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    await expectNothingRevoked();
  });

  it("Better Auth /organization/update-member-role admin → member", async () => {
    const { acme } = await seedWorld();
    const session = await seedSession("u_owner");
    const res = await authPost("/organization/update-member-role", session, {
      memberId: "m_admin",
      role: "member",
      organizationId: acme,
    });
    expect(res.status).toBe(200);
    expect(await revokedAt("t_admin_acme_gov")).not.toBeNull();
    expect(await revokedAt("t_admin_acme")).toBeNull();
  });
});

describe("user deletion revokes every token the user minted", () => {
  it("Better Auth /admin/remove-user", async () => {
    await seedWorld();
    await seedUser("u_operator", "admin");
    const session = await seedSession("u_operator");
    const res = await authPost("/admin/remove-user", session, { userId: "u_member" });
    expect(res.status).toBe(200);
    expect(await revokedAt("t_member_acme")).not.toBeNull();
    expect(await revokedAt("t_member_acme_gov")).not.toBeNull();
    expect(await revokedAt("t_member_beta")).not.toBeNull();
    expect(await revokedAt("t_admin_acme")).toBeNull();
    expect(await revokedAt("t_legacy_acme")).toBeNull();
  });

  it("a non-admin calling /admin/remove-user revokes nothing", async () => {
    await seedWorld();
    const session = await seedSession("u_admin");
    const res = await authPost("/admin/remove-user", session, { userId: "u_member" });
    expect(res.status).toBe(403);
    await expectNothingRevoked();
  });
});

describe("workspace-owned service tokens survive their minting admin (#1026)", () => {
  async function seedServiceToken() {
    await db
      .prepare(
        `INSERT INTO auth_tokens
           (id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at,
            minting_user_id, owner, created_by_user_id)
         VALUES ('t_service_acme', 'acme', 'hash-t_service_acme', 'CI', ?, ?, NULL, NULL,
                 NULL, 'workspace', 'u_admin')`,
      )
      .bind(JSON.stringify(FILE_SCOPES), "2026-09-01T00:00:00.000Z")
      .run();
  }

  it("removing the admin who minted it leaves it active", async () => {
    await seedWorld();
    await seedServiceToken();
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_admin?actorUserId=u_owner`,
      { method: "DELETE" },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    expect(await revokedAt("t_admin_acme")).not.toBeNull();
    expect(await revokedAt("t_service_acme")).toBeNull();
  });

  it("demoting the admin who minted it leaves it active", async () => {
    await seedWorld();
    await seedServiceToken();
    const res = await internalApp.request(
      `/internal/orgs/acme/members/m_admin`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorUserId: "u_owner", role: "member" }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(200);
    expect(await revokedAt("t_service_acme")).toBeNull();
  });

  it("deleting the admin's account leaves it active", async () => {
    await seedWorld();
    await seedServiceToken();
    await seedUser("u_operator", "admin");
    const session = await seedSession("u_operator");
    const res = await authPost("/admin/remove-user", session, { userId: "u_admin" });
    expect(res.status).toBe(200);
    expect(await revokedAt("t_admin_acme")).not.toBeNull();
    expect(await revokedAt("t_service_acme")).toBeNull();
  });
});

describe("isWorkspaceManagerRole", () => {
  it("accepts admin/owner alone, comma-joined, or as an array", () => {
    expect(isWorkspaceManagerRole("admin")).toBe(true);
    expect(isWorkspaceManagerRole("owner")).toBe(true);
    expect(isWorkspaceManagerRole("member,admin")).toBe(true);
    expect(isWorkspaceManagerRole(["member", "owner"])).toBe(true);
  });

  it("rejects member and empty roles", () => {
    expect(isWorkspaceManagerRole("member")).toBe(false);
    expect(isWorkspaceManagerRole("")).toBe(false);
    expect(isWorkspaceManagerRole(null)).toBe(false);
    expect(isWorkspaceManagerRole(["member"])).toBe(false);
  });
});
