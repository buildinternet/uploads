/**
 * Issue #912: OAuth refresh-grant observability. Two layers:
 *  - Pure unit coverage of `classifyOAuthTokenEvent` (every branch, no I/O).
 *  - End-to-end coverage driving `/api/auth/oauth2/token` through the real
 *    handler (same harness as oauth.test.ts's reuse-grace suite) with a fake
 *    AUTH_EVENTS binding, confirming the right event actually fires for each
 *    of the four #912 scenarios.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import {
  classifyOAuthTokenEvent,
  hashOAuthToken,
  snapshotPresentedRefreshToken,
  writeAuthEventPoint,
  type AuthEventFields,
  type AuthEventName,
} from "./oauth-observability";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

describe("classifyOAuthTokenEvent", () => {
  it("classifies a revoked-and-within-grace refresh token as a rotation replay", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      failed: false,
      hasRefreshToken: true,
      snapshot: { clientId: "c1", userId: "u1", revoked: true, withinReuseInterval: true },
    });
    expect(event).toEqual({
      name: "refresh_rotation_replay",
      fields: { clientId: "c1", userId: "u1", grantType: "refresh_token" },
    });
  });

  it("still classifies as a replay when the reuse-window attempt itself failed", () => {
    // The plugin's cached rotationReplayResponse can go missing (encryption
    // failure, storage eviction) even though the presented token IS within
    // the 60s grace — rare, but "a replay was attempted" is still the #912
    // signal that matters, not which of the two outcomes the plugin hit.
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      failed: true,
      errorCode: "invalid_grant",
      snapshot: { clientId: "c1", userId: "u1", revoked: true, withinReuseInterval: true },
    });
    expect(event?.name).toBe("refresh_rotation_replay");
  });

  it("classifies a revoked-and-outside-grace refresh token as family invalidation", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      failed: true,
      errorCode: "invalid_grant",
      snapshot: { clientId: "c1", userId: "u1", revoked: true, withinReuseInterval: false },
    });
    expect(event).toEqual({
      name: "refresh_family_invalidated",
      fields: { clientId: "c1", userId: "u1", grantType: "refresh_token" },
    });
  });

  it("classifies an unknown/foreign refresh token failure by its RFC 6749 error code", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      clientId: "c2",
      failed: true,
      errorCode: "invalid_scope",
    });
    expect(event).toEqual({
      name: "refresh_grant_failed",
      fields: { clientId: "c2", grantType: "refresh_token", errorCode: "invalid_scope" },
    });
  });

  it("ignores non-refresh-token grant failures (out of #912's scope)", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "authorization_code",
      failed: true,
      errorCode: "invalid_grant",
    });
    expect(event).toBeNull();
  });

  it("flags a successful refresh grant whose response carries no refresh_token", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      clientId: "c3",
      failed: false,
      hasRefreshToken: false,
    });
    expect(event).toEqual({
      name: "token_grant_without_refresh",
      fields: { clientId: "c3", grantType: "refresh_token" },
    });
  });

  it("flags a successful authorization_code grant whose response carries no refresh_token (#911's shape)", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "authorization_code",
      clientId: "c4",
      failed: false,
      hasRefreshToken: false,
    });
    expect(event?.name).toBe("token_grant_without_refresh");
  });

  it("emits nothing for an ordinary successful grant that does carry a refresh_token", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "refresh_token",
      clientId: "c5",
      failed: false,
      hasRefreshToken: true,
    });
    expect(event).toBeNull();
  });

  it("emits nothing for a client_credentials-style grant with no refresh_token expected", () => {
    const event = classifyOAuthTokenEvent({
      grantType: "client_credentials",
      clientId: "c6",
      failed: false,
      hasRefreshToken: false,
    });
    expect(event).toBeNull();
  });
});

describe("writeAuthEventPoint", () => {
  function fakeDataset() {
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    return {
      points,
      dataset: {
        writeDataPoint: (point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) => {
          points.push(point);
        },
      } as unknown as AnalyticsEngineDataset,
    };
  }

  it("no-ops silently when AUTH_EVENTS is unbound", () => {
    expect(() =>
      writeAuthEventPoint({}, "refresh_grant_failed", { errorCode: "invalid_grant" }),
    ).not.toThrow();
  });

  it("writes one point per event, blobs in the documented order", () => {
    const { points, dataset } = fakeDataset();
    const fields: AuthEventFields = {
      clientId: "c1",
      grantType: "refresh_token",
      errorCode: "invalid_grant",
      userId: "u1",
    };
    writeAuthEventPoint({ AUTH_EVENTS: dataset }, "refresh_grant_failed", fields);
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["refresh_grant_failed"]);
    expect(points[0]?.blobs).toEqual([
      "refresh_grant_failed",
      "c1",
      "refresh_token",
      "invalid_grant",
      "u1",
    ]);
  });

  it("never throws when the binding's writeDataPoint itself throws", () => {
    const dataset = {
      writeDataPoint: () => {
        throw new Error("AE quota exceeded");
      },
    } as unknown as AnalyticsEngineDataset;
    expect(() =>
      writeAuthEventPoint(
        { AUTH_EVENTS: dataset },
        "refresh_family_invalidated" as AuthEventName,
        {},
      ),
    ).not.toThrow();
  });
});

describe("snapshotPresentedRefreshToken", () => {
  function dbEnv(): AuthEnv {
    return {
      DB: createFakeD1(),
      WEB_ORIGIN: "https://uploads.sh",
      BETTER_AUTH_URL: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    };
  }

  async function seedClient(orm: ReturnType<typeof drizzle<typeof schema>>, clientId: string) {
    await orm.insert(schema.oauthClient).values({
      id: crypto.randomUUID(),
      clientId,
      name: "test client",
      scopes: ["files:read"],
      grantTypes: ["refresh_token"],
      redirectUris: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("returns undefined for a token that isn't in the table", async () => {
    const env = dbEnv();
    const orm = drizzle(env.DB, { schema });
    expect(await snapshotPresentedRefreshToken(orm, "no-such-token")).toBeUndefined();
  });

  it("reports revoked:false for an active, never-rotated token", async () => {
    const env = dbEnv();
    const orm = drizzle(env.DB, { schema });
    await seedClient(orm, "client-a");
    const userId = crypto.randomUUID();
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken("raw-active"),
      clientId: "client-a",
      userId,
      scopes: ["files:read"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const snapshot = await snapshotPresentedRefreshToken(orm, "raw-active");
    expect(snapshot).toEqual({
      clientId: "client-a",
      userId,
      revoked: false,
      withinReuseInterval: false,
    });
  });

  it("reports withinReuseInterval:true for a token rotated inside the 60s grace", async () => {
    const env = dbEnv();
    const orm = drizzle(env.DB, { schema });
    await seedClient(orm, "client-b");
    const userId = crypto.randomUUID();
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken("raw-rotated-recent"),
      clientId: "client-b",
      userId,
      scopes: ["files:read"],
      revoked: new Date(),
      rotatedAt: new Date(),
      rotationReplayExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const snapshot = await snapshotPresentedRefreshToken(orm, "raw-rotated-recent");
    expect(snapshot).toEqual({
      clientId: "client-b",
      userId,
      revoked: true,
      withinReuseInterval: true,
    });
  });

  it("reports withinReuseInterval:false once the reuse grace has lapsed", async () => {
    const env = dbEnv();
    const orm = drizzle(env.DB, { schema });
    await seedClient(orm, "client-c");
    const userId = crypto.randomUUID();
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken("raw-rotated-stale"),
      clientId: "client-c",
      userId,
      scopes: ["files:read"],
      revoked: new Date(Date.now() - 120_000),
      rotatedAt: new Date(Date.now() - 120_000),
      rotationReplayExpiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const snapshot = await snapshotPresentedRefreshToken(orm, "raw-rotated-stale");
    expect(snapshot).toEqual({
      clientId: "client-c",
      userId,
      revoked: true,
      withinReuseInterval: false,
    });
  });
});

describe("/oauth2/token end-to-end event emission", () => {
  function fakeDataset() {
    const points: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    return {
      points,
      dataset: {
        writeDataPoint: (point: { indexes?: string[]; blobs?: string[] }) => points.push(point),
      } as unknown as AnalyticsEngineDataset,
    };
  }

  function dbEnv(auth_events: AnalyticsEngineDataset): AuthEnv {
    return {
      DB: createFakeD1(),
      WEB_ORIGIN: "https://uploads.sh",
      BETTER_AUTH_URL: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
      AUTH_EVENTS: auth_events,
    };
  }

  async function registerClient(env: AuthEnv) {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "observability test",
          redirect_uris: ["http://127.0.0.1:19877/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    return client_id;
  }

  async function seedUser(env: AuthEnv) {
    const orm = drizzle(env.DB, { schema });
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Observability",
      email: `observability-${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { orm, userId };
  }

  async function refresh(env: AuthEnv, clientId: string, token: string) {
    return app.request(
      "/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: token,
        }).toString(),
      },
      env,
    );
  }

  it("emits refresh_rotation_replay on a reuse within the 60s grace", async () => {
    const { points, dataset } = fakeDataset();
    const env = dbEnv(dataset);
    const clientId = await registerClient(env);
    const { orm, userId } = await seedUser(env);
    const rawToken = "observability-raw-token";
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken(rawToken),
      clientId,
      userId,
      scopes: ["files:read", "files:write", "offline_access"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    const first = await refresh(env, clientId, rawToken);
    expect(first.status).toBe(200);
    // First refresh rotates a never-before-seen token: no #912 event.
    expect(points).toHaveLength(0);

    const replay = await refresh(env, clientId, rawToken);
    expect(replay.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["refresh_rotation_replay"]);
    expect(points[0]?.blobs?.[1]).toBe(clientId);
    expect(points[0]?.blobs?.[4]).toBe(userId);
  });

  it("emits refresh_family_invalidated on a reuse outside the grace window", async () => {
    const { points, dataset } = fakeDataset();
    const env = dbEnv(dataset);
    const clientId = await registerClient(env);
    const { orm, userId } = await seedUser(env);
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken("already-rotated"),
      clientId,
      userId,
      scopes: ["files:read", "offline_access"],
      revoked: new Date(Date.now() - 120_000),
      rotatedAt: new Date(Date.now() - 120_000),
      rotationReplayExpiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 200_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    const res = await refresh(env, clientId, "already-rotated");
    expect(res.status).toBe(400);
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["refresh_family_invalidated"]);
    expect(points[0]?.blobs?.[1]).toBe(clientId);
    expect(points[0]?.blobs?.[4]).toBe(userId);
  });

  it("emits refresh_grant_failed(invalid_grant) for an unknown refresh token", async () => {
    const { points, dataset } = fakeDataset();
    const env = dbEnv(dataset);
    const clientId = await registerClient(env);

    const res = await refresh(env, clientId, "never-issued-token");
    expect(res.status).toBe(400);
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["refresh_grant_failed"]);
    expect(points[0]?.blobs?.[3]).toBe("invalid_grant");
  });

  it("emits token_grant_without_refresh when the client can't hold offline_access", async () => {
    // Same shape #911 fixed: a client without offline_access in its
    // registered scopes gets no refresh_token in the code-exchange response.
    const { points, dataset } = fakeDataset();
    const env = dbEnv(dataset);
    const register = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "no-offline-access client",
          redirect_uris: ["http://127.0.0.1:19878/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      },
      env,
    );
    expect(register.status).toBe(201);
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const orm = drizzle(env.DB, { schema });
    // Downscope this client to a set that excludes offline_access, mirroring
    // how a pre-#913 client (or one that never requested it) would be seeded.
    await orm
      .update(schema.oauthClient)
      .set({ scopes: ["files:read"] })
      .where(eq(schema.oauthClient.clientId, clientId));

    const { userId } = await seedUser(env);
    // Exercising the full authorize→consent leg is out of scope for this
    // event-emission test — oauth.test.ts's reuse-grace suite already takes
    // the same "seed the refresh token row directly" shortcut for the token
    // endpoint. The refresh_token grant hits the identical `createUserTokens`
    // "no offline_access in scopes" path an authorization_code exchange would.
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashOAuthToken("no-offline-refresh"),
      clientId,
      userId,
      scopes: ["files:read"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    const res = await refresh(env, clientId, "no-offline-refresh");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token?: string };
    expect(body.refresh_token).toBeUndefined();
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["token_grant_without_refresh"]);
  });
});
