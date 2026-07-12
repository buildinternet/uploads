/**
 * Phase 4 (plan D5): the `deviceAuthorization` plugin's `validateClient`
 * allowlist plus a full claim → approve → token exchange. These drive the real
 * Better Auth handler (via src/index.ts's `app`) against the fake-D1 harness,
 * so they exercise the actual plugin wiring — not a re-implementation — and, in
 * the end-to-end case, prove the harness handles the plugin's
 * `consumeOne`/`incrementOne` (RETURNING + `WHERE id IN (SELECT …)`) SQL.
 */
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { app } from "./index";
import { UPLOADS_CLI_CLIENT_ID, type AuthEnv } from "./auth";
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

/** POST /api/auth/device/code with an application/json body (D5: NOT form-encoded). */
function requestDeviceCode(env: AuthEnv, body: Record<string, unknown>) {
  return app.request(
    "/api/auth/device/code",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("device/code validateClient allowlist", () => {
  it("issues a device + user code for the allowlisted CLI client id", async () => {
    const res = await requestDeviceCode(dbEnv(), { client_id: UPLOADS_CLI_CLIENT_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    };
    expect(typeof body.device_code).toBe("string");
    expect(typeof body.user_code).toBe("string");
    // verificationUri is an absolute URL on the WEB origin (the /device page is
    // served by apps/web, not this worker).
    expect(body.verification_uri).toBe("https://uploads.sh/device");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.interval).toBeGreaterThan(0);
  });

  it("rejects an unknown client id with invalid_client", async () => {
    const res = await requestDeviceCode(dbEnv(), { client_id: "not-the-cli" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });

  it("rejects a device/token exchange for an unknown client id", async () => {
    const res = await app.request(
      "/api/auth/device/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "whatever",
          client_id: "not-the-cli",
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });
});

describe("device flow end-to-end (claim → approve → token)", () => {
  /** Seed a user + an active session, returning the raw session token to present as a bearer. */
  async function seedSignedInUser(env: AuthEnv): Promise<string> {
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

  it("claims a code, approves it, and exchanges it for a session access token", async () => {
    // One env (one fake D1) reused across every request in the flow.
    const env = dbEnv();
    const sessionToken = await seedSignedInUser(env);

    // 1. CLI starts the flow (no session).
    const codeRes = await requestDeviceCode(env, { client_id: UPLOADS_CLI_CLIENT_ID });
    expect(codeRes.status).toBe(200);
    const { device_code, user_code } = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
    };

    // 2. Signed-in browser hits GET /device — this CLAIMS the code (binds userId
    //    via the plugin's `incrementOne`, i.e. UPDATE … WHERE id IN (SELECT …)).
    const verifyRes = await app.request(
      `/api/auth/device?user_code=${encodeURIComponent(user_code)}`,
      { headers: { Authorization: `Bearer ${sessionToken}` } },
      env,
    );
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json()) as { status?: string }).toMatchObject({ status: "pending" });

    // 3. Approve.
    const approveRes = await app.request(
      "/api/auth/device/approve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ userCode: user_code }),
      },
      env,
    );
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()) as { success?: boolean }).toMatchObject({ success: true });

    // 4. CLI polls device/token and gets a session access token (the plugin's
    //    `consumeOne`, i.e. DELETE … WHERE deviceCode = ? … RETURNING).
    const tokenRes = await app.request(
      "/api/auth/device/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code,
          client_id: UPLOADS_CLI_CLIENT_ID,
        }),
      },
      env,
    );
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token?: string; token_type?: string };
    expect(typeof token.access_token).toBe("string");
    expect(token.token_type).toBe("Bearer");
  });

  it("returns authorization_pending until the code is approved", async () => {
    const env = dbEnv();
    const codeRes = await requestDeviceCode(env, { client_id: UPLOADS_CLI_CLIENT_ID });
    const { device_code } = (await codeRes.json()) as { device_code: string };

    const tokenRes = await app.request(
      "/api/auth/device/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code,
          client_id: UPLOADS_CLI_CLIENT_ID,
        }),
      },
      env,
    );
    expect(tokenRes.status).toBe(400);
    expect((await tokenRes.json()) as { error?: string }).toMatchObject({
      error: "authorization_pending",
    });
  });
});
