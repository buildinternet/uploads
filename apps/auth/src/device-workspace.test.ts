/**
 * Issue #362 (auth side): the `/device/workspace` read + write endpoints that
 * let the approval page resolve and record which workspace a device login
 * mints for. Driven against the real Better Auth handler via src/index.ts's
 * `app` on the fake-D1 harness, same pattern as device.test.ts /
 * workspace-choice.test.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { parseDeviceScope, workspaceScopeValue } from "./device-workspace";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

/** Seed a user + active session + org memberships; returns the raw bearer token. */
async function seedSignedInUser(
  env: AuthEnv,
  orgSlugs: { slug: string; createdAt: Date }[] = [],
): Promise<{ userId: string; sessionToken: string }> {
  const orm = drizzle(env.DB, { schema });
  const userId = crypto.randomUUID();
  await orm.insert(schema.user).values({
    id: userId,
    name: "Ada Lovelace",
    email: `ada-${userId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: "user",
  });
  const sessionToken = `sess-${crypto.randomUUID()}`;
  await orm.insert(schema.session).values({
    id: crypto.randomUUID(),
    userId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (const { slug, createdAt } of orgSlugs) {
    const orgId = crypto.randomUUID();
    await orm.insert(schema.organization).values({ id: orgId, name: slug, slug, createdAt });
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role: "member",
      createdAt,
    });
  }
  return { userId, sessionToken };
}

/** Insert a device_code row directly — the plugin's own /device/code is exercised in device.test.ts. */
async function seedDeviceCode(
  env: AuthEnv,
  over: Partial<{
    userCode: string;
    scope: string | null;
    status: string;
    userId: string | null;
    expiresAt: Date;
  }> = {},
): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const userCode = over.userCode ?? "ABCDEFGH";
  await orm.insert(schema.deviceCode).values({
    id: crypto.randomUUID(),
    deviceCode: `dev-${crypto.randomUUID()}`,
    userCode,
    userId: over.userId ?? null,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    status: over.status ?? "pending",
    clientId: "uploads-cli",
    scope: over.scope ?? null,
  });
  return userCode;
}

function getWorkspace(env: AuthEnv, userCode: string, sessionToken?: string) {
  return app.request(
    `/api/auth/device/workspace?user_code=${encodeURIComponent(userCode)}`,
    { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {} },
    env,
  );
}

function postWorkspace(env: AuthEnv, body: unknown, sessionToken?: string) {
  return app.request(
    "/api/auth/device/workspace",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("parseDeviceScope", () => {
  it("reads the workspace and create tokens in any order", () => {
    expect(parseDeviceScope("workspace:acme")).toEqual({ workspace: "acme", create: false });
    expect(parseDeviceScope("workspace:acme create")).toEqual({ workspace: "acme", create: true });
    expect(parseDeviceScope("create workspace:acme")).toEqual({ workspace: "acme", create: true });
  });

  it("treats absent, empty, and unrelated scopes as no request", () => {
    expect(parseDeviceScope(null)).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("")).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("files:read files:write")).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("workspace:")).toEqual({ workspace: null, create: false });
  });
});

describe("workspaceScopeValue", () => {
  it("never carries create — a recorded choice always means the browser decided", () => {
    expect(workspaceScopeValue("acme")).toBe("workspace:acme");
  });
});

describe("GET /device/workspace", () => {
  it("401s when unauthenticated", async () => {
    const env = dbEnv();
    const userCode = await seedDeviceCode(env);
    expect((await getWorkspace(env, userCode)).status).toBe(401);
  });

  it("returns the requested workspace and the caller's memberships", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { scope: "workspace:default" });

    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requested: "default",
      create: false,
      workspaces: [
        { slug: "acme", name: "acme" },
        { slug: "beta", name: "beta" },
      ],
    });
  });

  it("accepts a hyphenated user code and reports no request when scope is empty", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    await seedDeviceCode(env, { userCode: "ABCDEFGH" });

    const res = await getWorkspace(env, "ABCD-EFGH", sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requested: null, create: false, workspaces: [] });
  });

  it("400s for an unknown user code", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const res = await getWorkspace(env, "ZZZZZZZZ", sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_user_code");
  });

  it("400s for an expired row", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const userCode = await seedDeviceCode(env, { expiresAt: new Date(Date.now() - 1000) });
    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("expired_user_code");
  });

  it("403s when the row was already claimed by another user", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const userCode = await seedDeviceCode(env, { userId: "someone-else" });
    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(403);
  });
});

describe("POST /device/workspace", () => {
  it("401s when unauthenticated", async () => {
    const env = dbEnv();
    const userCode = await seedDeviceCode(env);
    expect((await postWorkspace(env, { userCode, workspace: "acme" })).status).toBe(401);
  });

  it("writes workspace:<slug> onto the row for a valid membership", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { scope: "workspace:acme create" });

    const res = await postWorkspace(env, { userCode, workspace: "acme" }, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });

    const orm = drizzle(env.DB, { schema });
    const [row] = await orm
      .select()
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode));
    // `create` is dropped: a recorded choice always means the browser decided.
    expect(row?.scope).toBe("workspace:acme");
  });

  it("400s invalid_workspace for a non-membership slug", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env);
    const res = await postWorkspace(env, { userCode, workspace: "default" }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_workspace");
  });

  it("400s invalid_workspace for a malformed body", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env);
    const res = await postWorkspace(env, { userCode }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_workspace");
  });

  it("400s once the row is no longer pending", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { status: "approved" });
    const res = await postWorkspace(env, { userCode, workspace: "acme" }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("device_code_already_processed");
  });
});
