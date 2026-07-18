import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

/**
 * Lane 1 coverage for the operator OAuth-client CRUD routes
 * (.context/2026-07-18-oauth-admin-panel-contract.md) against the fake D1
 * harness: real migrations, real drizzle queries.
 */

let db: FakeD1Database;
let env: AuthEnv;

beforeEach(() => {
  db = createFakeD1();
  env = { DB: db, WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
});

function app() {
  return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
}

async function jsonReq(method: string, path: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const validCreateBody = {
  name: "My App",
  redirectUris: ["https://example.com/callback"],
  scopes: ["files:read", "files:write"],
};

describe("POST /internal/oauth-clients", () => {
  it("creates a public PKCE client and never returns clientSecret", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).toMatchObject({
      name: "My App",
      type: "web",
      public: true,
      disabled: false,
      official: false,
      redirectUris: ["https://example.com/callback"],
      scopes: ["files:read", "files:write"],
      uri: null,
      icon: null,
      userId: null,
      skipConsent: false,
      consentCount: 0,
      activeTokenCount: 0,
      lastConsentAt: null,
    });
    expect(typeof body.clientId).toBe("string");
    expect(typeof body.createdAt).toBe("number");
    expect(typeof body.updatedAt).toBe("number");
  });

  it("stores official:true in metadata and sets userId null", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      official: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.official).toBe(true);
    expect(body.userId).toBeNull();
  });

  it("400s on empty name", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      name: "  ",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("400s on a javascript: redirect URI", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      redirectUris: ["javascript:alert(1)"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("400s on a scope outside OAUTH_SCOPES", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      scopes: ["files:read", "admin:everything"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("accepts http loopback redirect URIs but rejects other http URIs", async () => {
    const ok = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      redirectUris: ["http://localhost:5173/callback", "http://127.0.0.1:5173/callback"],
    });
    expect(ok.status).toBe(201);

    const bad = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      redirectUris: ["http://example.com/callback"],
    });
    expect(bad.status).toBe(400);
  });

  it("400s on a redirect URI containing a fragment (RFC 6749 §3.1.2)", async () => {
    const res = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      redirectUris: ["https://example.com/callback#fragment"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /internal/oauth-clients", () => {
  it("lists clients ordered createdAt desc", async () => {
    const first = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      name: "First",
    });
    const firstBody = (await first.json()) as { clientId: string };
    const second = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      name: "Second",
    });
    const secondBody = (await second.json()) as { clientId: string };

    const res = await jsonReq("GET", "/internal/oauth-clients");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<{ clientId: string; name: string }> };
    // Issue #251 seeds an "uploads-cli" oauth_client row via migration, so a
    // clean DB has that row plus these two, not just these two.
    const created = body.clients.filter((c) => c.clientId !== "uploads-cli");
    expect(created).toHaveLength(2);
    expect(created[0].clientId).toBe(secondBody.clientId);
    expect(created[1].clientId).toBe(firstBody.clientId);
  });
});

describe("GET /internal/oauth-clients/:clientId", () => {
  it("404s for an unknown client", async () => {
    const res = await jsonReq("GET", "/internal/oauth-clients/does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_found" });
  });

  it("computes consent/token stats", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    const { clientId } = (await created.json()) as { clientId: string };

    const now = new Date();
    const later = new Date(now.getTime() + 1000);
    await drizzle(db, { schema })
      .insert(schema.oauthConsent)
      .values([
        {
          id: "consent-1",
          userId: "user-1",
          clientId,
          scopes: ["files:read"],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "consent-2",
          userId: "user-2",
          clientId,
          scopes: ["files:read"],
          createdAt: later,
          updatedAt: later,
        },
        // Second consent row for user-1: consentCount is DISTINCT so this
        // shouldn't bump the count above 2.
        {
          id: "consent-3",
          userId: "user-1",
          clientId,
          scopes: ["files:write"],
          createdAt: now,
          updatedAt: now,
        },
      ]);

    const activeExpiry = new Date(Date.now() + 1000 * 60 * 60);
    const expiredExpiry = new Date(Date.now() - 1000 * 60 * 60);
    await drizzle(db, { schema })
      .insert(schema.oauthRefreshToken)
      .values([
        {
          id: "rt-active",
          token: "tok-active",
          clientId,
          userId: "user-1",
          scopes: ["files:read"],
          createdAt: now,
          expiresAt: activeExpiry,
        },
        {
          id: "rt-revoked",
          token: "tok-revoked",
          clientId,
          userId: "user-1",
          scopes: ["files:read"],
          revoked: now,
          createdAt: now,
          expiresAt: activeExpiry,
        },
        {
          id: "rt-expired",
          token: "tok-expired",
          clientId,
          userId: "user-1",
          scopes: ["files:read"],
          createdAt: now,
          expiresAt: expiredExpiry,
        },
      ]);

    const res = await jsonReq("GET", `/internal/oauth-clients/${clientId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consentCount: number;
      activeTokenCount: number;
      lastConsentAt: number;
    };
    expect(body.consentCount).toBe(2);
    expect(body.activeTokenCount).toBe(1);
    // D1's integer timestamp mode stores second precision, so compare at
    // second granularity rather than exact epoch-ms equality.
    expect(Math.floor(body.lastConsentAt / 1000)).toBe(Math.floor(later.getTime() / 1000));
  });
});

describe("PATCH /internal/oauth-clients/:clientId", () => {
  it("404s for an unknown client", async () => {
    const res = await jsonReq("PATCH", "/internal/oauth-clients/does-not-exist", {
      disabled: true,
    });
    expect(res.status).toBe(404);
  });

  it("updates fields and toggles disabled", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    const { clientId } = (await created.json()) as { clientId: string };

    const res = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, {
      name: "Renamed",
      disabled: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; disabled: boolean };
    expect(body.name).toBe("Renamed");
    expect(body.disabled).toBe(true);
  });

  it("400s on an invalid patch value without mutating the row", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    const { clientId } = (await created.json()) as { clientId: string };

    const res = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, {
      redirectUris: ["javascript:alert(1)"],
    });
    expect(res.status).toBe(400);

    const check = await jsonReq("GET", `/internal/oauth-clients/${clientId}`);
    const body = (await check.json()) as { redirectUris: string[] };
    expect(body.redirectUris).toEqual(validCreateBody.redirectUris);
  });

  it("toggles official in metadata while preserving other metadata keys", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    const { clientId } = (await created.json()) as { clientId: string };

    // Seed an unrelated metadata key directly, simulating a client that
    // already carries other metadata alongside the official flag.
    await drizzle(db, { schema })
      .update(schema.oauthClient)
      .set({ metadata: { someOtherKey: "keep-me" } })
      .where(eqClientId(clientId));

    const setOfficial = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, {
      official: true,
    });
    expect(setOfficial.status).toBe(200);
    const setBody = (await setOfficial.json()) as { official: boolean };
    expect(setBody.official).toBe(true);

    const [rowAfterSet] = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eqClientId(clientId));
    expect(rowAfterSet.metadata).toMatchObject({ official: true, someOtherKey: "keep-me" });

    const unsetOfficial = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, {
      official: false,
    });
    expect(unsetOfficial.status).toBe(200);
    const unsetBody = (await unsetOfficial.json()) as { official: boolean };
    expect(unsetBody.official).toBe(false);

    const [rowAfterUnset] = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eqClientId(clientId));
    expect(rowAfterUnset.metadata).toMatchObject({ someOtherKey: "keep-me" });
    expect((rowAfterUnset.metadata as Record<string, unknown>).official).toBeUndefined();
  });

  it("clears uri when patched with null", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      uri: "https://example.com",
    });
    const { clientId } = (await created.json()) as { clientId: string };

    const res = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, { uri: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string | null };
    expect(body.uri).toBeNull();
  });
});

describe("DELETE /internal/oauth-clients/:clientId", () => {
  it("404s for an unknown client", async () => {
    const res = await jsonReq("DELETE", "/internal/oauth-clients/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("hard deletes the client and its dependent token/consent rows", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", validCreateBody);
    const { clientId } = (await created.json()) as { clientId: string };

    const now = new Date();
    await drizzle(db, { schema })
      .insert(schema.oauthConsent)
      .values({
        id: "consent-1",
        userId: "user-1",
        clientId,
        scopes: ["files:read"],
        createdAt: now,
        updatedAt: now,
      });
    await drizzle(db, { schema })
      .insert(schema.oauthRefreshToken)
      .values({
        id: "rt-1",
        token: "tok-1",
        clientId,
        userId: "user-1",
        scopes: ["files:read"],
        createdAt: now,
        expiresAt: new Date(Date.now() + 1000 * 60),
      });
    await drizzle(db, { schema })
      .insert(schema.oauthAccessToken)
      .values({
        id: "at-1",
        token: "atok-1",
        clientId,
        userId: "user-1",
        scopes: ["files:read"],
        createdAt: now,
        expiresAt: new Date(Date.now() + 1000 * 60),
      });

    const res = await jsonReq("DELETE", `/internal/oauth-clients/${clientId}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const remainingClients = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eqClientId(clientId));
    expect(remainingClients).toHaveLength(0);
    const remainingConsent = await drizzle(db, { schema })
      .select()
      .from(schema.oauthConsent)
      .where(eqClientIdConsent(clientId));
    expect(remainingConsent).toHaveLength(0);
    const remainingRefresh = await drizzle(db, { schema })
      .select()
      .from(schema.oauthRefreshToken)
      .where(eqClientIdRefresh(clientId));
    expect(remainingRefresh).toHaveLength(0);
    const remainingAccess = await drizzle(db, { schema })
      .select()
      .from(schema.oauthAccessToken)
      .where(eqClientIdAccess(clientId));
    expect(remainingAccess).toHaveLength(0);
  });

  it("409s on an official client and leaves its rows intact", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      official: true,
    });
    const { clientId } = (await created.json()) as { clientId: string };

    const now = new Date();
    await drizzle(db, { schema })
      .insert(schema.oauthConsent)
      .values({
        id: "consent-official",
        userId: "user-1",
        clientId,
        scopes: ["files:read"],
        createdAt: now,
        updatedAt: now,
      });
    await drizzle(db, { schema })
      .insert(schema.oauthRefreshToken)
      .values({
        id: "rt-official",
        token: "tok-official",
        clientId,
        userId: "user-1",
        scopes: ["files:read"],
        createdAt: now,
        expiresAt: new Date(Date.now() + 1000 * 60),
      });

    const res = await jsonReq("DELETE", `/internal/oauth-clients/${clientId}`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string; message: string }).toMatchObject({
      error: "official_client",
    });

    const remainingClients = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eqClientId(clientId));
    expect(remainingClients).toHaveLength(1);
    const remainingConsent = await drizzle(db, { schema })
      .select()
      .from(schema.oauthConsent)
      .where(eqClientIdConsent(clientId));
    expect(remainingConsent).toHaveLength(1);
    const remainingRefresh = await drizzle(db, { schema })
      .select()
      .from(schema.oauthRefreshToken)
      .where(eqClientIdRefresh(clientId));
    expect(remainingRefresh).toHaveLength(1);
  });

  it("succeeds after PATCHing official:false on a previously official client", async () => {
    const created = await jsonReq("POST", "/internal/oauth-clients", {
      ...validCreateBody,
      official: true,
    });
    const { clientId } = (await created.json()) as { clientId: string };

    const blocked = await jsonReq("DELETE", `/internal/oauth-clients/${clientId}`);
    expect(blocked.status).toBe(409);

    const patched = await jsonReq("PATCH", `/internal/oauth-clients/${clientId}`, {
      official: false,
    });
    expect(patched.status).toBe(200);

    const res = await jsonReq("DELETE", `/internal/oauth-clients/${clientId}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const remainingClients = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eqClientId(clientId));
    expect(remainingClients).toHaveLength(0);
  });
});

function eqClientId(clientId: string) {
  return eq(schema.oauthClient.clientId, clientId);
}
function eqClientIdConsent(clientId: string) {
  return eq(schema.oauthConsent.clientId, clientId);
}
function eqClientIdRefresh(clientId: string) {
  return eq(schema.oauthRefreshToken.clientId, clientId);
}
function eqClientIdAccess(clientId: string) {
  return eq(schema.oauthAccessToken.clientId, clientId);
}
