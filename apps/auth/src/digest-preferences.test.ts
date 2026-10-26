import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

async function seed(
  env: AuthEnv,
): Promise<{ userId: string; sessionToken: string; acmeId: string; betaId: string }> {
  const orm = drizzle(env.DB, { schema });
  const userId = "user-ada";
  const now = new Date();
  await orm.insert(schema.user).values({
    id: userId,
    name: "Ada",
    email: "ada@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  const sessionToken = "sess-ada";
  await orm.insert(schema.session).values({
    id: "sess-1",
    userId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  await orm.insert(schema.organization).values([
    { id: "org-acme", name: "Acme", slug: "acme", createdAt: now },
    { id: "org-beta", name: "Beta", slug: "beta", createdAt: now },
  ]);
  await orm.insert(schema.member).values([
    {
      id: "m-acme",
      organizationId: "org-acme",
      userId,
      role: "owner",
      createdAt: now,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: false,
    },
    {
      id: "m-beta",
      organizationId: "org-beta",
      userId,
      role: "member",
      createdAt: now,
    },
  ]);
  return { userId, sessionToken, acmeId: "org-acme", betaId: "org-beta" };
}

function authed(env: AuthEnv, path: string, sessionToken: string, init?: RequestInit) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        authorization: `Bearer ${sessionToken}`,
      },
    },
    env,
  );
}

describe("digest preferences", () => {
  it("lists one row per workspace and hides the admin pulse from a member", async () => {
    const env = dbEnv();
    const { sessionToken } = await seed(env);
    const res = await authed(env, "/api/auth/digest-preferences", sessionToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: Array<{ slug: string; admin: boolean; notifyWeeklyDigest: boolean }>;
    };
    expect(body.workspaces.map((row) => row.slug)).toEqual(["acme", "beta"]);
    expect(body.workspaces[0]).toMatchObject({
      slug: "acme",
      admin: true,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: false,
    });
    expect(body.workspaces[1]).toMatchObject({
      slug: "beta",
      role: "member",
      admin: false,
      notifyWeeklyDigest: false,
      notifyWeeklyWorkspaceDigest: false,
    });
  });

  it("requires a session", async () => {
    const env = dbEnv();
    const res = await app.request("/api/auth/digest-preferences", {}, env);
    expect(res.status).toBe(401);
  });

  it("updates one membership and refuses the admin pulse for a member", async () => {
    const env = dbEnv();
    const { sessionToken, betaId, acmeId } = await seed(env);
    const turnedOn = await authed(env, "/api/auth/digest-preferences", sessionToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: betaId, notifyWeeklyDigest: true }),
    });
    expect(turnedOn.status).toBe(200);
    expect(await turnedOn.json()).toMatchObject({
      workspace: { slug: "beta", notifyWeeklyDigest: true, admin: false },
    });

    const pulse = await authed(env, "/api/auth/digest-preferences", sessionToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: betaId, notifyWeeklyWorkspaceDigest: true }),
    });
    expect(pulse.status).toBe(403);

    const adminPulse = await authed(env, "/api/auth/digest-preferences", sessionToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: acmeId, notifyWeeklyWorkspaceDigest: true }),
    });
    expect(adminPulse.status).toBe(200);

    const orm = drizzle(env.DB, { schema });
    const rows = await orm.select().from(schema.member);
    expect(rows.find((row) => row.id === "m-beta")).toMatchObject({
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: false,
    });
    expect(rows.find((row) => row.id === "m-acme")).toMatchObject({
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: true,
    });
  });

  it("does not change a workspace the user is not in", async () => {
    const env = dbEnv();
    const { sessionToken } = await seed(env);
    const res = await authed(env, "/api/auth/digest-preferences", sessionToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org-other", notifyWeeklyDigest: true }),
    });
    expect(res.status).toBe(403);
    const orm = drizzle(env.DB, { schema });
    const [acme] = await orm.select().from(schema.member).where(eq(schema.member.id, "m-acme"));
    expect(acme?.notifyWeeklyDigest).toBe(true);
  });
});
