/**
 * OAuth 2.1 authorization server (issue #224, Lane A): migration/schema
 * parity, dynamic client registration, JWKS, workspace-claim mapping, and
 * the root `/.well-known/*` discovery aliases. Driven against the real
 * Better Auth handler (via src/index.ts's `app`) and the fake-D1 harness, so
 * migration drift between src/schema.ts and migrations/*.sql is caught here
 * — see src/test/fake-d1.ts.
 */
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
