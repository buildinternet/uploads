/**
 * Issue #231 (auth side): per-grant workspace choice. Covers the
 * `POST /oauth2/workspace-choice` endpoint (driven against the real Better
 * Auth handler via src/index.ts's `app`, same pattern as device.test.ts),
 * the `resolveWorkspaceChoiceReferenceId` postLogin hook, and the
 * `applyWorkspaceChoice` claims override — see src/workspace-choice.ts.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";
import { applyWorkspaceChoice, resolveWorkspaceChoiceReferenceId } from "./workspace-choice";

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

/** Seed a user + an active session, returning the raw session token to present as a bearer (pattern: device.test.ts). */
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

function requestWorkspaceChoice(env: AuthEnv, body: unknown, sessionToken?: string) {
  return app.request(
    "/api/auth/oauth2/workspace-choice",
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

describe("POST /oauth2/workspace-choice", () => {
  it("401s when unauthenticated", async () => {
    const res = await requestWorkspaceChoice(dbEnv(), { workspace: "acme" });
    expect(res.status).toBe(401);
  });

  it("400s with code invalid_workspace for a non-membership slug", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const res = await requestWorkspaceChoice(env, { workspace: "not-a-member-org" }, sessionToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_workspace");
  });

  it("400s with code invalid_workspace for a missing/malformed body", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const res = await requestWorkspaceChoice(env, {}, sessionToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_workspace");
  });

  it("upserts the choice and returns { status: true } on a valid membership", async () => {
    const env = dbEnv();
    const { userId, sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") },
    ]);

    const res1 = await requestWorkspaceChoice(env, { workspace: "acme" }, sessionToken);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ status: true });

    const orm = drizzle(env.DB, { schema });
    const [row1] = await orm
      .select()
      .from(schema.oauthWorkspaceChoice)
      .where(eq(schema.oauthWorkspaceChoice.userId, userId));
    expect(row1?.workspace).toBe("acme");

    // Re-picking updates the same row rather than inserting a second one.
    const res2 = await requestWorkspaceChoice(env, { workspace: "beta" }, sessionToken);
    expect(res2.status).toBe(200);

    const rows = await orm
      .select()
      .from(schema.oauthWorkspaceChoice)
      .where(eq(schema.oauthWorkspaceChoice.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace).toBe("beta");
  });
});

function requestWorkspaceChoiceGet(env: AuthEnv, sessionToken?: string) {
  return app.request(
    "/api/auth/oauth2/workspace-choice",
    {
      method: "GET",
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
    },
    env,
  );
}

describe("GET /oauth2/workspace-choice", () => {
  it("401s when unauthenticated", async () => {
    const res = await requestWorkspaceChoiceGet(dbEnv());
    expect(res.status).toBe(401);
  });

  it("returns { workspace: null } for a user with zero memberships", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const res = await requestWorkspaceChoiceGet(env, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: null });
  });

  it("resolves to the oldest membership when no choice is stored", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") },
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const res = await requestWorkspaceChoiceGet(env, sessionToken);
    expect(await res.json()).toEqual({ workspace: "acme" });
  });

  it("resolves to the stored choice while it is a live membership, else falls back", async () => {
    const env = dbEnv();
    const { userId, sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    const orm = drizzle(env.DB, { schema });
    await orm.insert(schema.oauthWorkspaceChoice).values({
      userId,
      workspace: "beta",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await requestWorkspaceChoiceGet(env, sessionToken);
    expect(await res.json()).toEqual({ workspace: "beta" });

    // Stale choice (membership gone) falls back to the oldest live one.
    await orm
      .update(schema.oauthWorkspaceChoice)
      .set({ workspace: "departed-org" })
      .where(eq(schema.oauthWorkspaceChoice.userId, userId));
    const res2 = await requestWorkspaceChoiceGet(env, sessionToken);
    expect(await res2.json()).toEqual({ workspace: "acme" });
  });
});

describe("resolveWorkspaceChoiceReferenceId", () => {
  it("returns undefined for an undefined user", async () => {
    const db = drizzle(createFakeD1(), { schema });
    expect(await resolveWorkspaceChoiceReferenceId(db, undefined)).toBeUndefined();
  });

  it("returns undefined for a user with zero memberships", async () => {
    const env = dbEnv();
    const { userId } = await seedSignedInUser(env, []);
    const db = drizzle(env.DB, { schema });
    expect(await resolveWorkspaceChoiceReferenceId(db, userId)).toBeUndefined();
  });

  it("returns undefined for a user with exactly one membership", async () => {
    const env = dbEnv();
    const { userId } = await seedSignedInUser(env, [
      { slug: "solo-org", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const db = drizzle(env.DB, { schema });
    expect(await resolveWorkspaceChoiceReferenceId(db, userId)).toBeUndefined();
  });

  it("returns ws:<oldest-slug> for a multi-workspace user with no stored choice", async () => {
    const env = dbEnv();
    const { userId } = await seedSignedInUser(env, [
      { slug: "newer-org", createdAt: new Date("2026-02-01T00:00:00Z") },
      { slug: "older-org", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const db = drizzle(env.DB, { schema });
    expect(await resolveWorkspaceChoiceReferenceId(db, userId)).toBe("ws:older-org");
  });

  it("returns ws:<stored-choice> when the stored choice is still a live membership", async () => {
    const env = dbEnv();
    const { userId } = await seedSignedInUser(env, [
      { slug: "newer-org", createdAt: new Date("2026-02-01T00:00:00Z") },
      { slug: "older-org", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const db = drizzle(env.DB, { schema });
    const now = new Date();
    await db
      .insert(schema.oauthWorkspaceChoice)
      .values({ userId, workspace: "newer-org", createdAt: now, updatedAt: now });

    expect(await resolveWorkspaceChoiceReferenceId(db, userId)).toBe("ws:newer-org");
  });

  it("falls back to the oldest membership when the stored choice is no longer a live membership", async () => {
    const env = dbEnv();
    const { userId } = await seedSignedInUser(env, [
      { slug: "newer-org", createdAt: new Date("2026-02-01T00:00:00Z") },
      { slug: "older-org", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const db = drizzle(env.DB, { schema });
    const now = new Date();
    await db.insert(schema.oauthWorkspaceChoice).values({
      userId,
      workspace: "stale-org-no-longer-a-member",
      createdAt: now,
      updatedAt: now,
    });

    expect(await resolveWorkspaceChoiceReferenceId(db, userId)).toBe("ws:older-org");
  });
});

describe("applyWorkspaceChoice", () => {
  const claims = { workspace: "older-org", workspaces: ["older-org", "newer-org"] };

  it("overrides workspace when referenceId names a workspace the user belongs to", () => {
    expect(applyWorkspaceChoice(claims, "ws:newer-org")).toEqual({
      workspace: "newer-org",
      workspaces: ["older-org", "newer-org"],
    });
  });

  it("ignores a referenceId for a workspace the user does not belong to", () => {
    expect(applyWorkspaceChoice(claims, "ws:not-a-member-org")).toEqual(claims);
  });

  it("ignores an undefined referenceId", () => {
    expect(applyWorkspaceChoice(claims, undefined)).toEqual(claims);
  });

  it("ignores a referenceId that isn't one of ours (no ws: prefix)", () => {
    expect(applyWorkspaceChoice(claims, "some-other-reference")).toEqual(claims);
  });
});
