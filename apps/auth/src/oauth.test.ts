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
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id?: string; redirect_uris?: string[] };
    expect(typeof body.client_id).toBe("string");
    expect(body.redirect_uris).toEqual(["https://client.example.com/callback"]);
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
    expect(body.issuer).toBe("https://auth.uploads.sh/api/auth");
  });

  it("serves the RFC 8414 path-inserted form", async () => {
    const res = await app.request(
      "/.well-known/oauth-authorization-server/some/issuer/path",
      {},
      dbEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { issuer?: string };
    expect(body.issuer).toBe("https://auth.uploads.sh/api/auth");
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
