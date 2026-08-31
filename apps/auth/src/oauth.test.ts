/**
 * OAuth 2.1 authorization server (issue #224, Lane A): migration/schema
 * parity, dynamic client registration, JWKS, workspace-claim mapping, and
 * the root `/.well-known/*` discovery aliases. Driven against the real
 * Better Auth handler (via src/index.ts's `app`) and the fake-D1 harness, so
 * migration drift between src/schema.ts and migrations/*.sql is caught here
 * — see src/test/fake-d1.ts.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceClaims, type AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

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

describe("oauth-provider migration/schema parity", () => {
  it("creates the jwks + oauth_* tables the migration defines", () => {
    const db = createFakeD1();
    const tables = db.__sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const table of [
      "jwks",
      "oauth_client",
      "oauth_access_token",
      "oauth_refresh_token",
      "oauth_consent",
    ]) {
      expect(tables).toContain(table);
    }
  });
});

describe("oauth resources", () => {
  it("seeds origin-shaped MCP identifiers alongside /mcp", async () => {
    const env = dbEnv();
    const res = await app.request("/.well-known/oauth-authorization-server", {}, env);
    expect(res.status).toBe(200);
    const orm = drizzle(env.DB, { schema });
    const rows = await orm
      .select({ identifier: schema.oauthResource.identifier })
      .from(schema.oauthResource);
    const ids = rows.map((r) => r.identifier);
    expect(ids).toEqual(
      expect.arrayContaining([
        "https://agents.uploads.sh/mcp",
        "https://agents.uploads.sh",
        "https://mcp.uploads.sh/mcp",
        "https://mcp.uploads.sh",
      ]),
    );
  });
});

describe("dynamic client registration", () => {
  it("registers a client via POST /api/auth/oauth2/register (unauthenticated)", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP Client",
          redirect_uris: ["https://client.example.com/callback"],
        }),
      },
      dbEnv(),
    );
    // Better Auth 1.7 returns RFC 7591-compliant 201 Created for DCR (was 200).
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id?: string; redirect_uris?: string[] };
    expect(typeof body.client_id).toBe("string");
    expect(body.redirect_uris).toEqual(["https://client.example.com/callback"]);
  });

  // Better Auth 1.7 defaults DCR clients without `application_type` to "web",
  // and web clients reject http loopback redirect URIs outright — which broke
  // every bare-DCR MCP client with a http://127.0.0.1:<port> callback
  // (opencode, reported 2026-08-30). The hooks.before interop defaults such
  // registrations to "native", where RFC 8252 loopback redirects are allowed.
  it("registers a DCR client with only http loopback redirects as native (opencode regression)", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "opencode",
          redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application_type?: string; redirect_uris?: string[] };
    expect(body.application_type).toBe("native");
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:19876/mcp/oauth/callback"]);
  });

  // Pins current upstream behavior (better-auth#10913: the web-client check
  // rejects ALL loopback redirects, even https). If a Better Auth release
  // starts allowing web+loopback, this test failing is the signal to revisit
  // — the interop default above stays correct either way.
  it("still rejects an explicit web client with a http loopback redirect", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "explicit web",
          application_type: "web",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(400);
  });

  // Cursor's MCP client sends an explicit `application_type: "web"` with a
  // cursor:// private-use-scheme redirect — a known Cursor bug (no legitimate
  // web client can register a custom-scheme callback):
  // https://forum.cursor.com/t/cursor-does-not-send-application-type-native-when-registering-mcp-oauth-clients/136907
  // The interop coerces this to "native" before the plugin validates it.
  it("registers Cursor's explicit web + cursor:// DCR body as native", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application_type: "web",
          redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application_type?: string; redirect_uris?: string[] };
    expect(body.application_type).toBe("native");
    expect(body.redirect_uris).toEqual(["cursor://anysphere.cursor-mcp/oauth/callback"]);
  });

  // Cursor's real registration (observed in prod 2026-08-30, unlike the
  // approximation in better-auth#10946) pairs the cursor:// callback with an
  // https redirect. Native clients may use claimed https URIs (RFC 8252
  // §7.2), so a private-use scheme ANYWHERE in redirect_uris still means the
  // client cannot be web — coercion must not require every URI to be
  // native-only shaped.
  it("registers Cursor's mixed cursor:// + https DCR body as native", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application_type: "web",
          redirect_uris: [
            "cursor://anysphere.cursor-mcp/oauth/callback",
            "https://cursor.com/api/mcp/oauth/callback",
          ],
          token_endpoint_auth_method: "none",
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application_type?: string; redirect_uris?: string[] };
    expect(body.application_type).toBe("native");
    expect(body.redirect_uris).toEqual([
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://cursor.com/api/mcp/oauth/callback",
    ]);
  });

  // Pins the pnpm patch of @better-auth/oauth-provider (better-auth#10956,
  // porting the upstream fix for better-auth#10946): the dist's native
  // redirect validator rejected host-bearing private-use-scheme redirects
  // like `cursor://host/path` even for an explicit `application_type:
  // "native"` client. Delete this test (and patches/@better-auth__oauth-provider@1.7.1.patch)
  // once a Better Auth release ships #10956 or equivalent.
  it("registers an explicit native client with a host-bearing cursor:// redirect", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application_type: "native",
          redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application_type?: string; redirect_uris?: string[] };
    expect(body.application_type).toBe("native");
    expect(body.redirect_uris).toEqual(["cursor://anysphere.cursor-mcp/oauth/callback"]);
  });

  it("leaves registrations with a non-loopback redirect defaulting to web", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "mixed",
          redirect_uris: ["https://client.example.com/callback"],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { application_type?: string };
    expect(body.application_type).toBe("web");
  });
});

describe("JWKS endpoint", () => {
  it("serves a key set at /api/auth/jwks", async () => {
    const res = await app.request("/api/auth/jwks", {}, dbEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys?: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys?.length).toBeGreaterThan(0);
  });
});

describe("root discovery aliases", () => {
  it("serves /.well-known/oauth-authorization-server with issuer ending /api/auth and CORS *", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {}, dbEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { issuer?: string };
    expect(body.issuer).toBe("https://uploads.sh/api/auth");
  });

  it("serves the RFC 8414 path-inserted form", async () => {
    // The path a client actually derives from our issuer
    // (https://uploads.sh/api/auth) per RFC 8414 §3.1.
    const res = await app.request("/.well-known/oauth-authorization-server/api/auth", {}, dbEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { issuer?: string };
    expect(body.issuer).toBe("https://uploads.sh/api/auth");
  });

  // #731 phase C: auth.uploads.sh keeps serving this alias for old clients
  // that never migrate off it — but the issuer it returns follows
  // BETTER_AUTH_URL, so it now points them at the NEW (uploads.sh) issuer.
  // This is the deprecation path, not a bug: an old client's discovery still
  // resolves, and lands on the same authorization server as everyone else.
  it("the root discovery alias serves the new issuer once BETTER_AUTH_URL is uploads.sh (deprecation path for old clients hitting auth.uploads.sh)", async () => {
    const res = await app.request(
      "/.well-known/oauth-authorization-server",
      {},
      dbEnv({ BETTER_AUTH_URL: "https://uploads.sh" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer?: string };
    expect(body.issuer).toBe("https://uploads.sh/api/auth");
  });

  it("forwards /.well-known/openid-configuration with CORS * (404: no `openid` scope, no OIDC id_token — honest metadata)", async () => {
    const res = await app.request("/.well-known/openid-configuration", {}, dbEnv());
    // The oauth-provider plugin 404s this endpoint unless "openid" is in its
    // configured `scopes` — this AS issues only files:* scopes and no
    // id_token, so this is the correct, honest response, not a bug. The
    // assertion that matters here is that the alias forwards to the plugin
    // (not a routing 404) and still stamps CORS.
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("refresh token rotation reuse grace", () => {
  // PR #909: `refreshTokenReuseInterval: 60` on oauthProvider(). Without it
  // (the base plugin's default is 0), reusing a just-rotated refresh token —
  // a network retry whose first attempt landed, or two processes of one
  // client sharing a stored token (multiple OpenCode sessions) — is treated
  // as theft and tears down the whole refresh-token family per RFC 9700
  // §4.14, forcing interactive re-auth. This pins the grace surviving Better
  // Auth upgrades (exactly the kind of default that shifted in 1.6→1.7).

  /** Mirrors the plugin's defaultHasher: SHA-256, base64url, no padding. */
  async function hashToken(raw: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
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

  it("replays the same rotated pair on reuse within the window instead of invalidating the family", async () => {
    const env = dbEnv();
    // Public native client via real DCR (same path OpenCode takes).
    const register = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "reuse-grace test",
          redirect_uris: ["http://127.0.0.1:19876/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      },
      env,
    );
    expect(register.status).toBe(201);
    const { client_id: clientId } = (await register.json()) as { client_id: string };

    // Seed the user + an active refresh token directly (skipping the
    // interactive authorize/consent leg — token-endpoint behavior is what's
    // under test).
    const orm = drizzle(env.DB, { schema });
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Reuse Grace",
      email: `reuse-grace-${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The plugin only issues refresh tokens when the grant carries
    // offline_access (introspect createUserTokens), and validates a refresh
    // grant's scopes against the client's registered list — grant the client
    // offline_access directly (DCR discards requested scope; see the
    // clientRegistrationAllowedScopes comment in auth.ts).
    (env.DB as FakeD1Database).__sqlite
      .prepare("UPDATE oauth_client SET scopes = ? WHERE client_id = ?")
      .run(
        JSON.stringify(["files:read", "files:write", "files:delete", "offline_access"]),
        clientId,
      );
    const rawToken = "reuse-grace-raw-refresh-token";
    await orm.insert(schema.oauthRefreshToken).values({
      id: crypto.randomUUID(),
      token: await hashToken(rawToken),
      clientId,
      userId,
      scopes: ["files:read", "files:write", "offline_access"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    // First refresh rotates: new pair issued, old row revoked with a replay
    // window stamped ~60s out.
    const first = await refresh(env, clientId, rawToken);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { access_token: string; refresh_token: string };
    expect(firstBody.refresh_token).toBeTruthy();
    const [rotated] = await orm
      .select({
        revoked: schema.oauthRefreshToken.revoked,
        rotationReplayExpiresAt: schema.oauthRefreshToken.rotationReplayExpiresAt,
      })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, await hashToken(rawToken)));
    expect(rotated?.revoked).toBeTruthy();
    expect(rotated?.rotationReplayExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Reuse of the just-rotated token within the window: the SAME pair comes
    // back (replayed response) — not invalid_grant, not a family teardown.
    const replay = await refresh(env, clientId, rawToken);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { access_token: string; refresh_token: string };
    expect(replayBody.refresh_token).toBe(firstBody.refresh_token);
    expect(replayBody.access_token).toBe(firstBody.access_token);

    // The rotated-to token is still alive: the family survived the reuse.
    const second = await refresh(env, clientId, firstBody.refresh_token);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { refresh_token: string };
    expect(secondBody.refresh_token).not.toBe(firstBody.refresh_token);
  });
});

describe("resolveWorkspaceClaims", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  it("returns null workspace and empty workspaces for an undefined user", async () => {
    expect(await resolveWorkspaceClaims(orm, undefined)).toEqual({
      workspace: null,
      workspaces: [],
    });
  });

  it("returns null workspace and empty workspaces for a user with no memberships", async () => {
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "No Org",
      email: `no-org-${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await resolveWorkspaceClaims(orm, userId)).toEqual({
      workspace: null,
      workspaces: [],
    });
  });

  it("returns the oldest membership's slug as primary, all slugs in workspaces", async () => {
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Multi Org",
      email: `multi-org-${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const orgs = [
      { id: crypto.randomUUID(), slug: "newer-org" },
      { id: crypto.randomUUID(), slug: "older-org" },
    ];
    for (const org of orgs) {
      await orm.insert(schema.organization).values({
        id: org.id,
        name: org.slug,
        slug: org.slug,
        createdAt: new Date(),
      });
    }

    // Insert the "older" membership second but with an earlier createdAt, so
    // ordering by createdAt (not insertion order) is what's exercised.
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgs[0]!.id,
      userId,
      role: "member",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgs[1]!.id,
      userId,
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const claims = await resolveWorkspaceClaims(orm, userId);
    expect(claims.workspace).toBe("older-org");
    expect(new Set(claims.workspaces)).toEqual(new Set(["older-org", "newer-org"]));
    expect(claims.workspaces).toHaveLength(2);
  });
});
