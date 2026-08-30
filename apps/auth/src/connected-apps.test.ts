/**
 * Issue #890 (auth side): GET /oauth2/connected-apps and
 * POST /oauth2/connected-apps/revoke — see src/connected-apps.ts. Driven
 * against the real Better Auth handler via src/index.ts's `app` on the
 * fake-D1 harness, same pattern as workspace-choice.test.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
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

async function seedSignedInUser(env: AuthEnv): Promise<{ userId: string; sessionToken: string }> {
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
  return { userId, sessionToken };
}

async function seedClient(
  env: AuthEnv,
  overrides: Partial<{
    clientId: string;
    name: string;
    icon: string | null;
    uri: string | null;
  }> = {},
): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const clientId = overrides.clientId ?? `client-${crypto.randomUUID()}`;
  await orm.insert(schema.oauthClient).values({
    id: crypto.randomUUID(),
    clientId,
    name: overrides.name ?? "Test App",
    icon: overrides.icon ?? null,
    uri: overrides.uri ?? null,
    redirectUris: ["https://example.com/callback"],
    scopes: ["files:read"],
    public: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return clientId;
}

async function seedGrant(
  env: AuthEnv,
  userId: string,
  clientId: string,
  opts: { referenceId?: string | null; scopes?: string[] } = {},
): Promise<{ consentId: string }> {
  const orm = drizzle(env.DB, { schema });
  const consentId = crypto.randomUUID();
  const referenceId = opts.referenceId ?? null;
  const scopes = opts.scopes ?? ["files:read"];
  await orm.insert(schema.oauthConsent).values({
    id: consentId,
    userId,
    clientId,
    referenceId,
    scopes,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await orm.insert(schema.oauthAccessToken).values({
    id: crypto.randomUUID(),
    token: `at-${crypto.randomUUID()}`,
    clientId,
    userId,
    referenceId,
    scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  await orm.insert(schema.oauthRefreshToken).values({
    id: crypto.randomUUID(),
    token: `rt-${crypto.randomUUID()}`,
    clientId,
    userId,
    referenceId,
    scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { consentId };
}

function requestGet(env: AuthEnv, sessionToken?: string) {
  return app.request(
    "/api/auth/oauth2/connected-apps",
    { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {} },
    env,
  );
}

function requestRevoke(env: AuthEnv, body: unknown, sessionToken?: string) {
  return app.request(
    "/api/auth/oauth2/connected-apps/revoke",
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

describe("GET /oauth2/connected-apps", () => {
  it("401s when unauthenticated", async () => {
    const res = await requestGet(dbEnv());
    expect(res.status).toBe(401);
  });

  it("returns [] with no grants", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const res = await requestGet(env, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [] });
  });

  it("joins consent to client and reports an active-token count", async () => {
    const env = dbEnv();
    const { userId, sessionToken } = await seedSignedInUser(env);
    const clientId = await seedClient(env, { name: "Acme Client", uri: "https://acme.example" });
    const { consentId } = await seedGrant(env, userId, clientId, {
      referenceId: "ws:acme",
      scopes: ["files:read", "files:write"],
    });

    const res = await requestGet(env, sessionToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: Array<Record<string, unknown>> };
    expect(body.grants).toHaveLength(1);
    const grant = body.grants[0];
    expect(grant.id).toBe(consentId);
    expect(grant.clientId).toBe(clientId);
    expect(grant.clientName).toBe("Acme Client");
    expect(grant.clientUri).toBe("https://acme.example");
    expect(grant.referenceId).toBe("ws:acme");
    expect(grant.scopes).toEqual(["files:read", "files:write"]);
    expect(grant.activeTokenCount).toBe(1);
  });

  it("only returns the session user's own grants", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const { userId: otherUserId } = await seedSignedInUser(env);
    const clientId = await seedClient(env);
    await seedGrant(env, otherUserId, clientId);

    const res = await requestGet(env, sessionToken);
    expect(await res.json()).toEqual({ grants: [] });
  });
});

describe("POST /oauth2/connected-apps/revoke", () => {
  it("401s when unauthenticated", async () => {
    const res = await requestRevoke(dbEnv(), { id: "does-not-matter" });
    expect(res.status).toBe(401);
  });

  it("404s for a missing or foreign consent id", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const { userId: otherUserId } = await seedSignedInUser(env);
    const clientId = await seedClient(env);
    const { consentId } = await seedGrant(env, otherUserId, clientId);

    const missing = await requestRevoke(env, { id: "nope" }, sessionToken);
    expect(missing.status).toBe(404);

    const foreign = await requestRevoke(env, { id: consentId }, sessionToken);
    expect(foreign.status).toBe(404);
  });

  it("deletes the consent row and revokes matching access/refresh tokens", async () => {
    const env = dbEnv();
    const { userId, sessionToken } = await seedSignedInUser(env);
    const clientId = await seedClient(env);
    const { consentId } = await seedGrant(env, userId, clientId, { referenceId: "ws:acme" });

    const res = await requestRevoke(env, { id: consentId }, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });

    const orm = drizzle(env.DB, { schema });
    const consents = await orm
      .select()
      .from(schema.oauthConsent)
      .where(eq(schema.oauthConsent.id, consentId));
    expect(consents).toHaveLength(0);

    const accessTokens = await orm
      .select()
      .from(schema.oauthAccessToken)
      .where(
        and(
          eq(schema.oauthAccessToken.userId, userId),
          eq(schema.oauthAccessToken.clientId, clientId),
        ),
      );
    expect(accessTokens.every((t) => t.revoked instanceof Date)).toBe(true);

    const refreshTokens = await orm
      .select()
      .from(schema.oauthRefreshToken)
      .where(
        and(
          eq(schema.oauthRefreshToken.userId, userId),
          eq(schema.oauthRefreshToken.clientId, clientId),
        ),
      );
    expect(refreshTokens.every((t) => t.revoked instanceof Date)).toBe(true);

    // A second revoke of the same (now-deleted) id 404s rather than
    // silently succeeding.
    const again = await requestRevoke(env, { id: consentId }, sessionToken);
    expect(again.status).toBe(404);
  });

  it("does not revoke another grant's tokens for the same client (referenceId scoping)", async () => {
    const env = dbEnv();
    const { userId, sessionToken } = await seedSignedInUser(env);
    const clientId = await seedClient(env);
    const { consentId: acmeConsentId } = await seedGrant(env, userId, clientId, {
      referenceId: "ws:acme",
    });
    await seedGrant(env, userId, clientId, { referenceId: "ws:beta" });

    await requestRevoke(env, { id: acmeConsentId }, sessionToken);

    const orm = drizzle(env.DB, { schema });
    const betaRefresh = await orm
      .select()
      .from(schema.oauthRefreshToken)
      .where(
        and(
          eq(schema.oauthRefreshToken.userId, userId),
          eq(schema.oauthRefreshToken.clientId, clientId),
          eq(schema.oauthRefreshToken.referenceId, "ws:beta"),
        ),
      );
    expect(betaRefresh).toHaveLength(1);
    expect(betaRefresh[0]?.revoked).toBeNull();

    const acmeRefresh = await orm
      .select()
      .from(schema.oauthRefreshToken)
      .where(
        and(
          eq(schema.oauthRefreshToken.userId, userId),
          eq(schema.oauthRefreshToken.clientId, clientId),
          isNull(schema.oauthRefreshToken.referenceId),
        ),
      );
    // sanity: no null-referenceId row exists (both grants used explicit refs)
    expect(acmeRefresh).toHaveLength(0);
  });
});
