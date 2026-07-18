/**
 * Audit guard (accidental-deletion class, see ad736b9's official-client
 * guard): the stock admin() plugin's `/admin/remove-user` and
 * `/admin/ban-user` routes already reject self-targeting on their own
 * (better-auth 1.6.23's `YOU_CANNOT_REMOVE_YOURSELF`/`YOU_CANNOT_BAN_YOURSELF`
 * checks), but had no protection against removing/banning the LAST remaining
 * admin. `hasAdminRole`/`countActiveAdmins` (src/auth.ts) back the
 * `hooks.before` guard wired into `buildAuth`.
 *
 * These are unit tests against the exported helpers plus endpoint-level
 * cases. Driving the "requester removes a *different* admin who is the sole
 * ACTIVE admin" case end-to-end isn't reachable through the plugin's own
 * session/permission stack: the admin() plugin's `adminMiddleware` requires
 * the requester to already hold the admin role, so if the target is genuinely
 * the only active admin, the requester (having admin role too) would have to
 * be that same user — a case the plugin's own self-guard already rejects
 * first. The remove/ban count<=1 branch therefore stays as defense in depth
 * (banned targets return early — a banned ex-admin is not an active admin
 * and may be removed freely); the branch is meaningfully reachable via the
 * set-role/update-user demotion paths tested below.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { app } from "./index";
import { countActiveAdmins, hasAdminRole, type AuthEnv } from "./auth";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

async function seedUser(
  env: AuthEnv,
  overrides: Partial<schema.AuthUser> = {},
): Promise<schema.AuthUser> {
  const orm = drizzle(env.DB, { schema });
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

/** Seed a session for `user`, returning the raw token to present as a bearer (same pattern as device.test.ts). */
async function seedSession(env: AuthEnv, userId: string): Promise<string> {
  const orm = drizzle(env.DB, { schema });
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

function adminRequest(
  path: string,
  sessionToken: string,
  body: Record<string, unknown>,
  env: AuthEnv,
) {
  return app.request(
    `/api/auth${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("hasAdminRole", () => {
  it("matches an exact admin role", () => {
    expect(hasAdminRole("admin")).toBe(true);
  });

  it("matches admin within a comma-separated role list", () => {
    expect(hasAdminRole("user,admin")).toBe(true);
  });

  it("rejects non-admin roles and empty values", () => {
    expect(hasAdminRole("user")).toBe(false);
    expect(hasAdminRole("")).toBe(false);
    expect(hasAdminRole(null)).toBe(false);
    expect(hasAdminRole(undefined)).toBe(false);
  });
});

describe("countActiveAdmins", () => {
  it("counts only non-banned admin-role users", async () => {
    const env = dbEnv();
    const db = drizzle(env.DB, { schema });
    await seedUser(env, { role: "admin" });
    await seedUser(env, { role: "admin", banned: true });
    await seedUser(env, { role: "user" });

    expect(await countActiveAdmins(db)).toBe(1);
  });

  it("returns 0 when there are no admins", async () => {
    const env = dbEnv();
    const db = drizzle(env.DB, { schema });
    await seedUser(env, { role: "user" });

    expect(await countActiveAdmins(db)).toBe(0);
  });

  it("counts every active admin when several exist", async () => {
    const env = dbEnv();
    const db = drizzle(env.DB, { schema });
    await seedUser(env, { role: "admin" });
    await seedUser(env, { role: "admin" });
    await seedUser(env, { role: "user" });

    expect(await countActiveAdmins(db)).toBe(2);
  });
});

describe("last-admin guard (endpoint-level)", () => {
  it("allows removing a banned ex-admin — they are not an active admin", async () => {
    const env = dbEnv();
    const activeAdmin = await seedUser(env, { role: "admin" });
    const bannedAdmin = await seedUser(env, { role: "admin", banned: true });
    const sessionToken = await seedSession(env, activeAdmin.id);

    const res = await adminRequest(
      "/admin/remove-user",
      sessionToken,
      { userId: bannedAdmin.id },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);

    const db = drizzle(env.DB, { schema });
    const [removed] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, bannedAdmin.id));
    expect(removed).toBeUndefined();
    const [survivor] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, activeAdmin.id));
    expect(survivor).toBeDefined();
  });

  it("allows removing a non-admin user even with only one admin in the system", async () => {
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const regularUser = await seedUser(env, { role: "user" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest(
      "/admin/remove-user",
      sessionToken,
      { userId: regularUser.id },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });

  it("allows removing one of two active admins, leaving the other", async () => {
    const env = dbEnv();
    const requester = await seedUser(env, { role: "admin" });
    const otherAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, requester.id);

    const res = await adminRequest(
      "/admin/remove-user",
      sessionToken,
      { userId: otherAdmin.id },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });

  it("still rejects an admin trying to remove themselves (library's own guard)", async () => {
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest(
      "/admin/remove-user",
      sessionToken,
      { userId: soleAdmin.id },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("blocks the sole admin from banning themselves", async () => {
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest("/admin/ban-user", sessionToken, { userId: soleAdmin.id }, env);
    expect(res.status).toBe(400);

    const db = drizzle(env.DB, { schema });
    const [row] = await db
      .select({ banned: schema.user.banned })
      .from(schema.user)
      .where(eq(schema.user.id, soleAdmin.id));
    expect(row?.banned).not.toBe(true);
  });

  it("allows one of two active admins to ban the other", async () => {
    const env = dbEnv();
    const requester = await seedUser(env, { role: "admin" });
    const otherAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, requester.id);

    const res = await adminRequest("/admin/ban-user", sessionToken, { userId: otherAdmin.id }, env);
    expect(res.status).toBe(200);

    const db = drizzle(env.DB, { schema });
    const [row] = await db
      .select({ banned: schema.user.banned })
      .from(schema.user)
      .where(eq(schema.user.id, otherAdmin.id));
    expect(row?.banned).toBe(true);
  });
});

describe("last-admin guard: set-role", () => {
  it("blocks set-role from demoting the last admin (including self-demotion)", async () => {
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest(
      "/admin/set-role",
      sessionToken,
      { userId: soleAdmin.id, role: "user" },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/cannot remove the last admin's admin role/i);

    const db = drizzle(env.DB, { schema });
    const [stillAdmin] = await db
      .select({ role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.id, soleAdmin.id));
    expect(hasAdminRole(stillAdmin?.role)).toBe(true);
  });

  it("allows set-role on a non-last admin", async () => {
    const env = dbEnv();
    const requester = await seedUser(env, { role: "admin" });
    const otherAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, requester.id);

    const res = await adminRequest(
      "/admin/set-role",
      sessionToken,
      { userId: otherAdmin.id, role: "user" },
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("last-admin guard: update-user", () => {
  it("blocks update-user from banning the last admin", async () => {
    // The reachable end-to-end path mirrors admin-last-guard's remove-user
    // test: adminMiddleware requires the requester to already hold the admin
    // role, so a sole active admin banning "the last admin" is necessarily
    // self-targeting. Our hooks.before guard runs before the route handler,
    // so it trips (with our message) ahead of the library's own
    // self-ban-only check.
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest(
      "/admin/update-user",
      sessionToken,
      { userId: soleAdmin.id, data: { banned: true } },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/cannot ban the last admin/i);
  });

  it("allows update-user to change unrelated fields on the last admin", async () => {
    const env = dbEnv();
    const soleAdmin = await seedUser(env, { role: "admin" });
    const sessionToken = await seedSession(env, soleAdmin.id);

    const res = await adminRequest(
      "/admin/update-user",
      sessionToken,
      { userId: soleAdmin.id, data: { name: "Renamed Admin" } },
      env,
    );
    expect(res.status).toBe(200);

    const db = drizzle(env.DB, { schema });
    const [updated] = await db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, soleAdmin.id));
    expect(updated?.name).toBe("Renamed Admin");
  });
});
