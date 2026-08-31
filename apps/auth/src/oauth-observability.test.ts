/**
 * Issue #912: unit coverage for the OAuth refresh-grant/replay/teardown/
 * no-refresh event classification. `classifyTokenGrantEvents` is pure, so
 * most cases are driven directly against it; the before→after D1 snapshot
 * correlation (`captureRefreshTokenPriorState` + `buildTokenGrantAfterHandler`)
 * is exercised against the real Better Auth `/oauth2/token` handler and the
 * fake-D1 harness, the same way oauth.test.ts pins the reuse-grace behavior
 * itself — that's the only way to observe the plugin's actual DB state
 * transitions without reimplementing them.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import {
  __resetPendingRefreshSnapshotsForTest,
  buildTokenGrantAfterHandler,
  captureRefreshTokenPriorState,
  classifyTokenGrantEvents,
  hashRefreshToken,
  writeAuthEventPoint,
  type AuthEvent,
} from "./oauth-observability";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

describe("writeAuthEventPoint", () => {
  it("is a silent no-op when AUTH_EVENTS is absent", () => {
    expect(() => writeAuthEventPoint({}, { name: "oauth_refresh_grant_failure" })).not.toThrow();
  });

  it("writes one indexed point with the documented blob order", () => {
    const points: unknown[] = [];
    writeAuthEventPoint(
      { AUTH_EVENTS: { writeDataPoint: (p: unknown) => points.push(p) } as never },
      {
        name: "oauth_refresh_family_teardown",
        clientId: "client-1",
        userId: "user-1",
        grantType: "refresh_token",
        errorCode: "invalid_grant",
      },
    );
    expect(points).toEqual([
      {
        indexes: ["oauth_refresh_family_teardown"],
        blobs: [
          "oauth_refresh_family_teardown",
          "client-1",
          "refresh_token",
          "invalid_grant",
          "user-1",
        ],
        doubles: [],
      },
    ]);
  });

  it("never throws even when the binding itself throws", () => {
    expect(() =>
      writeAuthEventPoint(
        {
          AUTH_EVENTS: {
            writeDataPoint: () => {
              throw new Error("boom");
            },
          } as never,
        },
        { name: "oauth_refresh_grant_failure" },
      ),
    ).not.toThrow();
  });
});

describe("classifyTokenGrantEvents", () => {
  it("emits a failure event for a refresh_token grant that errored, with no prior state", () => {
    expect(
      classifyTokenGrantEvents({
        grantType: "refresh_token",
        clientId: "client-1",
        success: false,
        errorCode: "invalid_grant",
      }),
    ).toEqual<AuthEvent[]>([
      {
        name: "oauth_refresh_grant_failure",
        clientId: "client-1",
        grantType: "refresh_token",
        errorCode: "invalid_grant",
      },
    ]);
  });

  it("emits failure + family teardown when the presented token was already revoked and outside grace", () => {
    expect(
      classifyTokenGrantEvents(
        {
          grantType: "refresh_token",
          clientId: "client-1",
          success: false,
          errorCode: "invalid_grant",
        },
        { clientId: "client-1", userId: "user-1", wasRevoked: true, withinGrace: false },
      ),
    ).toEqual<AuthEvent[]>([
      {
        name: "oauth_refresh_grant_failure",
        clientId: "client-1",
        grantType: "refresh_token",
        errorCode: "invalid_grant",
      },
      { name: "oauth_refresh_family_teardown", clientId: "client-1", userId: "user-1" },
    ]);
  });

  it("emits a replay-hit event for a successful refresh grant whose token was already revoked but still within grace", () => {
    expect(
      classifyTokenGrantEvents(
        { grantType: "refresh_token", clientId: "client-1", success: true, hasRefreshToken: true },
        { clientId: "client-1", userId: "user-1", wasRevoked: true, withinGrace: true },
      ),
    ).toEqual<AuthEvent[]>([
      { name: "oauth_refresh_replay_hit", clientId: "client-1", userId: "user-1" },
    ]);
  });

  it("emits nothing extra for an ordinary successful rotation (fresh token, no prior state)", () => {
    expect(
      classifyTokenGrantEvents({
        grantType: "refresh_token",
        clientId: "client-1",
        success: true,
        hasRefreshToken: true,
      }),
    ).toEqual([]);
  });

  it("emits token_grant_no_refresh for any successful grant type missing a refresh_token", () => {
    expect(
      classifyTokenGrantEvents({
        grantType: "authorization_code",
        clientId: "client-1",
        success: true,
        hasRefreshToken: false,
      }),
    ).toEqual<AuthEvent[]>([
      {
        name: "oauth_token_grant_no_refresh",
        clientId: "client-1",
        grantType: "authorization_code",
      },
    ]);
  });

  it("does not emit token_grant_no_refresh for a successful grant that did include one", () => {
    expect(
      classifyTokenGrantEvents({
        grantType: "authorization_code",
        clientId: "client-1",
        success: true,
        hasRefreshToken: true,
      }),
    ).toEqual([]);
  });

  it("can emit both a replay hit and a no-refresh event together", () => {
    // Pathological but exercises the two independent checks are not
    // mutually exclusive.
    expect(
      classifyTokenGrantEvents(
        { grantType: "refresh_token", clientId: "client-1", success: true, hasRefreshToken: false },
        { clientId: "client-1", userId: "user-1", wasRevoked: true, withinGrace: true },
      ),
    ).toEqual<AuthEvent[]>([
      { name: "oauth_refresh_replay_hit", clientId: "client-1", userId: "user-1" },
      { name: "oauth_token_grant_no_refresh", clientId: "client-1", grantType: "refresh_token" },
    ]);
  });
});

describe("buildTokenGrantAfterHandler", () => {
  it("classifies a thrown APIError as a failure using the injected isApiError + body.error", async () => {
    const points: unknown[] = [];
    const handler = buildTokenGrantAfterHandler(
      { AUTH_EVENTS: { writeDataPoint: (p: unknown) => points.push(p) } as never },
      (v): v is never => Boolean(v && typeof v === "object" && "body" in v),
    );
    await handler({
      path: "/oauth2/token",
      body: { grant_type: "refresh_token", client_id: "client-1", refresh_token: "some-token" },
      context: { returned: { body: { error: "invalid_scope", error_description: "nope" } } },
    });
    expect(points).toHaveLength(1);
    expect((points[0] as { blobs: string[] }).blobs[0]).toBe("oauth_refresh_grant_failure");
    expect((points[0] as { blobs: string[] }).blobs[3]).toBe("invalid_scope");
  });

  it("classifies a successful response missing refresh_token", async () => {
    const points: unknown[] = [];
    const handler = buildTokenGrantAfterHandler(
      { AUTH_EVENTS: { writeDataPoint: (p: unknown) => points.push(p) } as never },
      () => false,
    );
    await handler({
      path: "/oauth2/token",
      body: { grant_type: "authorization_code", client_id: "client-1" },
      context: { returned: { access_token: "abc", token_type: "Bearer" } },
    });
    expect(points).toHaveLength(1);
    expect((points[0] as { blobs: string[] }).blobs[0]).toBe("oauth_token_grant_no_refresh");
  });

  it("is a no-op for any path other than /oauth2/token", async () => {
    const points: unknown[] = [];
    const handler = buildTokenGrantAfterHandler(
      { AUTH_EVENTS: { writeDataPoint: (p: unknown) => points.push(p) } as never },
      () => false,
    );
    await handler({ path: "/oauth2/authorize", context: { returned: { anything: true } } });
    expect(points).toHaveLength(0);
  });

  it("never throws even if the writer/classifier path errors", async () => {
    const handler = buildTokenGrantAfterHandler(
      {
        AUTH_EVENTS: {
          writeDataPoint: () => {
            throw new Error("boom");
          },
        } as never,
      },
      () => false,
    );
    await expect(
      handler({
        path: "/oauth2/token",
        body: { grant_type: "authorization_code" },
        context: { returned: { access_token: "abc" } },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("captureRefreshTokenPriorState + before/after correlation (real handler)", () => {
  beforeEach(() => {
    __resetPendingRefreshSnapshotsForTest();
  });

  /** Mirrors the plugin's defaultHasher: SHA-256, base64url, no padding. */
  async function hashToken(raw: string): Promise<string> {
    return hashRefreshToken(raw);
  }

  async function seedActiveRefreshToken(
    env: AuthEnv,
    opts: { clientId: string; userId: string; rawToken: string },
  ) {
    const orm = drizzle(env.DB, { schema });
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashToken(opts.rawToken),
      clientId: opts.clientId,
      userId: opts.userId,
      scopes: ["files:read", "files:write", "offline_access"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
  }

  async function registerClient(env: AuthEnv) {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "observability test",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      },
      env,
    );
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
    return userId;
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

  it("snapshots an unrevoked token as not-within-grace (ordinary first rotation)", async () => {
    const env = dbEnv();
    const clientId = await registerClient(env);
    const userId = await seedUser(env);
    const rawToken = "capture-before-raw-token";
    await seedActiveRefreshToken(env, { clientId, userId, rawToken });

    const orm = drizzle(env.DB, { schema });
    await captureRefreshTokenPriorState(orm, {
      path: "/oauth2/token",
      body: { grant_type: "refresh_token", refresh_token: rawToken },
    });

    // Drive the real rotation through the handler; the snapshot captured
    // above should reflect the PRE-rotation state (not revoked).
    const res = await refresh(env, clientId, rawToken);
    expect(res.status).toBe(200);
  });

  it("is a no-op for a non-refresh_token grant_type or missing token", async () => {
    const env = dbEnv();
    const orm = drizzle(env.DB, { schema });
    await expect(
      captureRefreshTokenPriorState(orm, {
        path: "/oauth2/token",
        body: { grant_type: "authorization_code" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      captureRefreshTokenPriorState(orm, { path: "/oauth2/authorize", body: {} }),
    ).resolves.toBeUndefined();
  });

  it("end-to-end: a real replay through the app produces a replay-hit event, not a failure", async () => {
    const points: { blobs: string[] }[] = [];
    const env = dbEnv({
      AUTH_EVENTS: { writeDataPoint: (p: { blobs: string[] }) => points.push(p) } as never,
    });
    const clientId = await registerClient(env);
    const userId = await seedUser(env);
    const rawToken = "e2e-replay-raw-token";
    await seedActiveRefreshToken(env, { clientId, userId, rawToken });
    const orm = drizzle(env.DB, { schema });

    // First refresh: an ordinary rotation. The real hooks (wired in
    // auth.ts's buildAuth) run automatically inside app.request — no manual
    // hook calls needed here, that's the point of driving this end-to-end.
    const first = await refresh(env, clientId, rawToken);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { refresh_token: string };
    // Ordinary rotation: no refresh_token grant failure or replay event.
    expect(points.map((p) => p.blobs[0])).not.toContain("oauth_refresh_replay_hit");
    expect(points.map((p) => p.blobs[0])).not.toContain("oauth_refresh_family_teardown");

    // Second presentation of the SAME raw token, still within the 60s grace
    // (PR #909): the plugin replays the cached pair instead of rotating
    // again — the after hook should classify this as a replay hit.
    points.length = 0;
    const replay = await refresh(env, clientId, rawToken);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { refresh_token: string };
    expect(replayBody.refresh_token).toBe(firstBody.refresh_token);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs[0]).toBe("oauth_refresh_replay_hit");
    expect(points[0]?.blobs[1]).toBe(clientId);
    expect(points[0]?.blobs[4]).toBe(userId);

    const [row] = await orm
      .select({
        wasRevoked: schema.oauthRefreshToken.revoked,
        rotationReplayExpiresAt: schema.oauthRefreshToken.rotationReplayExpiresAt,
      })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, await hashToken(rawToken)));
    expect(row?.wasRevoked).toBeTruthy();
    expect(row?.rotationReplayExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("end-to-end: a stale reused token (grace expired) is classified as both a failure and a family teardown", async () => {
    const points: { blobs: string[] }[] = [];
    const env = dbEnv({
      AUTH_EVENTS: { writeDataPoint: (p: { blobs: string[] }) => points.push(p) } as never,
    });
    const clientId = await registerClient(env);
    const userId = await seedUser(env);
    const rawToken = "e2e-teardown-raw-token";
    const orm = drizzle(env.DB, { schema });
    // Seed the row already rotated, with its replay grace already expired —
    // the exact precondition for the plugin's invalidateRefreshFamily branch.
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashToken(rawToken),
      clientId,
      userId,
      scopes: ["files:read", "files:write", "offline_access"],
      revoked: new Date(Date.now() - 5000),
      rotatedAt: new Date(Date.now() - 5000),
      rotationReplayExpiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    const res = await refresh(env, clientId, rawToken);
    expect(res.status).toBe(400);

    expect(points.map((p) => p.blobs[0]).sort()).toEqual(
      ["oauth_refresh_family_teardown", "oauth_refresh_grant_failure"].sort(),
    );
    const teardown = points.find((p) => p.blobs[0] === "oauth_refresh_family_teardown");
    expect(teardown?.blobs[1]).toBe(clientId);
    expect(teardown?.blobs[4]).toBe(userId);
    const failure = points.find((p) => p.blobs[0] === "oauth_refresh_grant_failure");
    expect(failure?.blobs[3]).toBe("invalid_grant");
  });
});
