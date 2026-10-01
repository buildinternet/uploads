/**
 * GET /oauth2/public-client carries `official` for the consent page's
 * Verified badge — see src/oauth-public-client.ts. Driven against the real
 * Better Auth handler on the fake-D1 harness, same pattern as
 * connected-apps.test.ts.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
  };
}

async function seedSession(env: AuthEnv): Promise<string> {
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

async function register(env: AuthEnv, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request(
    "/api/auth/oauth2/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        client_uri: "https://claude.ai",
        redirect_uris: ["https://attacker.example.com/cb"],
        ...extra,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function publicClient(env: AuthEnv, clientId: string, sessionToken: string) {
  const res = await app.request(
    `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /oauth2/public-client official flag", () => {
  it("is true for an operator-flagged official client", async () => {
    const env = dbEnv();
    const sessionToken = await seedSession(env);
    // Migrations seed `releases-sh` with metadata {official: true}.
    const { status, body } = await publicClient(env, "releases-sh", sessionToken);
    expect(status).toBe(200);
    expect(body.client_id).toBe("releases-sh");
    expect(body.official).toBe(true);
  });

  it("is false for a self-registered client", async () => {
    const env = dbEnv();
    const sessionToken = await seedSession(env);
    const clientId = await register(env);
    const { status, body } = await publicClient(env, clientId, sessionToken);
    expect(status).toBe(200);
    expect(body.client_name).toBe("Claude");
    expect(body.official).toBe(false);
  });

  it("cannot be self-asserted at registration", async () => {
    const env = dbEnv();
    const sessionToken = await seedSession(env);
    const clientId = await register(env, { official: true, metadata: { official: true } });
    const [row] = await drizzle(env.DB, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId));
    expect(row?.metadata ?? null).toBeNull();
    const { body } = await publicClient(env, clientId, sessionToken);
    expect(body.official).toBe(false);
  });

  it("still 404s for an unknown client", async () => {
    const env = dbEnv();
    const sessionToken = await seedSession(env);
    const { status, body } = await publicClient(env, "nope", sessionToken);
    expect(status).toBe(404);
    expect(body).not.toHaveProperty("official");
  });
});
