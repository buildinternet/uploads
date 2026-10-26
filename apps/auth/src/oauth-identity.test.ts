import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function identityEnv(): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
  };
}

async function registerClient(env: AuthEnv) {
  const register = await app.request(
    "/api/auth/oauth2/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OIDC test",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    },
    env,
  );
  expect(register.status).toBe(201);
  return (await register.json()) as { client_id: string; scope: string };
}

async function refreshIdentity(
  scopes: string[],
  emailVerified: boolean,
  options: { requestedScope?: string; clientScopes?: string[] } = {},
) {
  const env = identityEnv();
  const registration = await registerClient(env);
  expect(registration.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
  const orm = drizzle(env.DB, { schema });
  if (options.clientScopes) {
    await orm
      .update(schema.oauthClient)
      .set({ scopes: options.clientScopes })
      .where(eq(schema.oauthClient.clientId, registration.client_id));
  }
  const userId = crypto.randomUUID();
  const email = `${userId}@example.com`;
  await orm.insert(schema.user).values({
    id: userId,
    name: "Identity test",
    email,
    emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const organizationId = crypto.randomUUID();
  await orm.insert(schema.organization).values({
    id: organizationId,
    name: "Identity workspace",
    slug: "identity-workspace",
    createdAt: new Date(),
  });
  await orm.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
  // Seed an already-consented grant, then exercise real token issuance and
  // UserInfo. Consent scope filtering is covered in oauth-grant-scopes.test.ts.
  const rawRefreshToken = crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawRefreshToken));
  const tokenHash = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  await orm.insert(schema.oauthRefreshToken).values({
    id: crypto.randomUUID(),
    token: tokenHash,
    clientId: registration.client_id,
    userId,
    scopes: [...scopes, "offline_access"],
    resources: ["https://agents.uploads.sh/mcp"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  const response = await app.request(
    "/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: rawRefreshToken,
        ...(options.requestedScope ? { scope: options.requestedScope } : {}),
      }).toString(),
    },
    env,
  );
  if (response.status !== 200) return { response };
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    scope: string;
  };
  expect(tokens.refresh_token).toBeTruthy();
  // Resource-bound MCP grants use signed JWT access tokens, rather than the
  // opaque token lane used by identity-only clients with no resource.
  const tokenParts = tokens.access_token.split(".");
  expect(tokenParts).toHaveLength(3);
  const payload = JSON.parse(atob(tokenParts[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as {
    aud: string[];
    workspace?: string;
    workspaces?: string[];
  };
  expect(payload.aud).toContain("https://agents.uploads.sh/mcp");
  const userInfo = await app.request(
    "/api/auth/oauth2/userinfo",
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
    env,
  );
  return { response, userInfo, tokens, payload, userId, email };
}

describe("OIDC identity claims", () => {
  it("keeps omitted authorize scopes file-only", async () => {
    const env = identityEnv();
    const client = await registerClient(env);
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("scope")?.split(" ")).toEqual([
      "files:read",
      "files:write",
      "files:delete",
      "offline_access",
    ]);
  });

  it("does not expand an existing client's persisted scope ceiling", async () => {
    const env = identityEnv();
    const client = await registerClient(env);
    await drizzle(env.DB, { schema })
      .update(schema.oauthClient)
      .set({ scopes: ["files:read", "offline_access"] })
      .where(eq(schema.oauthClient.clientId, client.client_id));
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "openid email",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("fails closed when registered client permissions cannot be read", async () => {
    const env = identityEnv();
    const client = await registerClient(env);
    const prepare = env.DB.prepare.bind(env.DB);
    const fault = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith('select "scopes" from "oauth_client"'))
        throw new Error("simulated D1 read failure");
      return prepare(sql);
    });
    try {
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        scope: "openid email",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      });
      const response = await app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    } finally {
      fault.mockRestore();
    }
  });

  it("rejects email-only authorization instead of adding openid", async () => {
    const env = identityEnv();
    const client = await registerClient(env);
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "email",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://agents.uploads.sh/mcp",
    });
    const response = await app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it.each([true, false])(
    "returns truthful email verification (%s) after refresh",
    async (verified) => {
      const result = await refreshIdentity(["files:read", "openid", "email"], verified);
      expect(result.response.status).toBe(200);
      const { userInfo, tokens, payload, userId, email } = result;
      if (!userInfo || !tokens || !payload) throw new Error("Identity refresh failed");
      expect(tokens.id_token).toBeTruthy();
      expect(payload.workspace).toBe("identity-workspace");
      expect(payload.workspaces).toEqual(["identity-workspace"]);
      expect(tokens.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
      expect(userInfo.status).toBe(200);
      expect(await userInfo.json()).toMatchObject({ sub: userId, email, email_verified: verified });
    },
  );

  it("issues identity-only resource JWTs without workspace authority or membership claims", async () => {
    const { userInfo, tokens, payload, userId } = await refreshIdentity(["openid"], true);
    if (!userInfo || !tokens || !payload) throw new Error("Identity refresh failed");
    expect(tokens.id_token).toBeTruthy();
    expect(tokens.scope.split(" ")).toEqual(["openid", "offline_access"]);
    expect(payload).not.toHaveProperty("workspace");
    expect(payload).not.toHaveProperty("workspaces");
    expect(userInfo.status).toBe(200);
    expect(await userInfo.json()).toMatchObject({ sub: userId });
  });

  it("omits email claims without the email scope", async () => {
    const { userInfo, userId } = await refreshIdentity(["files:read", "openid"], true);
    if (!userInfo) throw new Error("Identity refresh failed");
    expect(userInfo.status).toBe(200);
    const claims = await userInfo.json();
    expect(claims).toMatchObject({ sub: userId });
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("email_verified");
  });

  it("preserves file-only grants and rejects UserInfo without openid", async () => {
    const { userInfo, tokens } = await refreshIdentity(["files:read"], true);
    if (!userInfo || !tokens) throw new Error("File refresh failed");
    expect(tokens.id_token).toBeUndefined();
    expect(tokens.scope.split(" ")).not.toContain("openid");
    expect(tokens.scope.split(" ")).not.toContain("email");
    expect(userInfo.status).toBe(400);
    expect(await userInfo.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("does not add identity scopes while refreshing an existing file-only grant", async () => {
    const result = await refreshIdentity(["files:read"], true, {
      clientScopes: ["files:read", "offline_access"],
    });
    expect(result.response.status).toBe(200);
    expect(result.tokens?.scope.split(" ")).toEqual(["files:read", "offline_access"]);
    expect(result.tokens?.id_token).toBeUndefined();
  });

  it.each([
    { scopes: ["files:read"], requestedScope: "openid email" },
    { scopes: ["openid", "email"], requestedScope: "email" },
  ])(
    "rejects refresh scope escalation or email without openid: $requestedScope",
    async (options) => {
      const result = await refreshIdentity(options.scopes, true, options);
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toMatchObject({ error: "invalid_scope" });
    },
  );
});
