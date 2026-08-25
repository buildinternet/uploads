/**
 * CIMD client registration (issue #556): URL-form `client_id` resolution via
 * `@better-auth/cimd`, the Workers fetch transport, AS-metadata advertising,
 * and the SEP-837 `application_type` DCR field. Driven against the real
 * Better Auth handler (src/index.ts's `app`) and the fake-D1 harness, with
 * the metadata-document fetch stubbed at the global `fetch` seam the Workers
 * transport uses.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import {
  fetchClientMetadataResource,
  intersectAdvertisedGrantTypes,
  rewriteClientMetadataGrantTypes,
} from "./cimd-transport";
import { app } from "./index";
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

const CLIENT_ID_URL = "https://client.example.com/oauth-client.json";
const REDIRECT_URI = "https://client.example.com/callback";

/** Minimal metadata document satisfying the mcp-2026-07-28 profile. */
function metadataDocument(): Record<string, unknown> {
  return {
    client_id: CLIENT_ID_URL,
    client_name: "Test CIMD MCP Client",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function stubMetadataFetch(body: unknown = metadataDocument()) {
  const impl = vi.fn(async () =>
    Response.json(body, { headers: { "cache-control": "max-age=300" } }),
  );
  vi.stubGlobal("fetch", impl);
  return impl;
}

async function authorize(env: AuthEnv, params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    client_id: CLIENT_ID_URL,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "files:read",
    state: "test-state",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    ...params,
  });
  return app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AS metadata", () => {
  it("advertises client_id_metadata_document_supported", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {}, dbEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id_metadata_document_supported?: boolean };
    expect(body.client_id_metadata_document_supported).toBe(true);
  });
});

describe("CIMD client resolution", () => {
  it("resolves a URL client_id at /oauth2/authorize and persists a discovery-owned client", async () => {
    const env = dbEnv();
    const fetchImpl = stubMetadataFetch();

    const res = await authorize(env);

    // Unauthenticated user with a valid client → redirect to the login page,
    // never an invalid_client error.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    expect(fetchImpl).toHaveBeenCalledOnce();

    const orm = drizzle(env.DB, { schema });
    const [row] = await orm
      .select({
        clientId: schema.oauthClient.clientId,
        discovery: schema.oauthClient.clientDiscoveryId,
        userId: schema.oauthClient.userId,
        skipConsent: schema.oauthClient.skipConsent,
      })
      .from(schema.oauthClient)
      // The fake-D1 migration chain seeds the managed `uploads-cli` row —
      // select only the discovery-created client.
      .where(eq(schema.oauthClient.clientId, CLIENT_ID_URL));
    expect(row?.clientId).toBe(CLIENT_ID_URL);
    expect(row?.discovery).toBe("cimd");
    // Anonymous + untrusted: stays within the stale-client reaper's candidate
    // predicate, so unused CIMD rows are swept like abandoned DCR rows.
    expect(row?.userId).toBeNull();
    expect(row?.skipConsent).toBeFalsy();
  });

  it("lets a self-registered client request files:delete (clientRegistrationAllowedScopes)", async () => {
    // Better Auth 1.7 persists self-registered clients with
    // defaultScopes ∪ allowedScopes and discards any document-declared
    // `scope` — without files:delete in clientRegistrationAllowedScopes this
    // request 400s with invalid_scope (found by the #556 Inspector run).
    const env = dbEnv();
    stubMetadataFetch();

    const res = await authorize(env, { scope: "files:read files:write files:delete" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("downscopes unknown extras (openid/admin) instead of invalid_scope", async () => {
    const env = dbEnv();
    stubMetadataFetch();

    const res = await authorize(env, {
      scope: "files:read files:write files:delete openid profile admin",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).not.toContain("invalid_scope");
  });

  it("accepts resource= origin as well as origin/mcp", async () => {
    const env = dbEnv();
    stubMetadataFetch();

    const origin = await authorize(env, { resource: "https://agents.uploads.sh" });
    expect(origin.status).toBe(302);
    expect(origin.headers.get("location")).toContain("/login");
    expect(origin.headers.get("location")).not.toContain("invalid_target");

    const path = await authorize(env, { resource: "https://agents.uploads.sh/mcp" });
    expect(path.status).toBe(302);
    expect(path.headers.get("location")).toContain("/login");
  });

  it("ingests MCPJam-shaped grant_types that include device_code", async () => {
    const env = dbEnv();
    stubMetadataFetch({
      ...metadataDocument(),
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });

    const res = await authorize(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).not.toContain("invalid_client_metadata");
  });

  it("ingests claude.ai-shaped grant_types that include jwt-bearer", async () => {
    const env = dbEnv();
    stubMetadataFetch({
      ...metadataDocument(),
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
    });

    const res = await authorize(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).not.toContain("invalid_client_metadata");
  });

  it("rejects a metadata document missing the MCP profile's required fields", async () => {
    const env = dbEnv();
    const { client_name: _omitted, ...withoutName } = metadataDocument();
    stubMetadataFetch(withoutName);

    const res = await authorize(env);
    // Resolution fails closed → the client does not exist for this AS.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a redirect_uri not listed in the metadata document", async () => {
    const env = dbEnv();
    stubMetadataFetch();

    const res = await authorize(env, { redirect_uri: "https://evil.example.com/callback" });
    // Exact-match failure sends the browser to the AS's own error page —
    // never to the unlisted redirect target.
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_redirect");
    expect(location).not.toContain("evil.example.com");
  });
});

describe("Workers CIMD transport", () => {
  it("refuses non-HTTPS URLs", async () => {
    await expect(
      fetchClientMetadataResource("http://client.example.com/meta.json"),
    ).rejects.toThrow(/HTTPS/);
  });

  it("refuses non-GET/HEAD methods", async () => {
    await expect(fetchClientMetadataResource(CLIENT_ID_URL, { method: "POST" })).rejects.toThrow(
      /GET and HEAD/,
    );
  });

  it("refuses loopback and private hosts", async () => {
    for (const url of [
      "https://localhost/meta.json",
      "https://127.0.0.1/meta.json",
      "https://192.168.1.10/meta.json",
      "https://169.254.169.254/meta.json",
    ]) {
      await expect(fetchClientMetadataResource(url)).rejects.toThrow(/rejected/);
    }
  });

  it("pins manual redirect handling even when called with redirect: 'error'", async () => {
    // The plugin passes `redirect: "error"`, which workerd's Request
    // constructor rejects — the transport must replace it with "manual"
    // BEFORE constructing the Request (caught by prod smoke; Node's undici
    // accepts "error" so this test can only pin the replacement behavior).
    const impl = vi.fn(async (req: Request) => {
      expect(req.redirect).toBe("manual");
      return Response.json(metadataDocument());
    });
    vi.stubGlobal("fetch", impl);
    const res = await fetchClientMetadataResource(CLIENT_ID_URL, { redirect: "error" });
    expect(res.status).toBe(200);
    expect(impl).toHaveBeenCalledOnce();
  });
});

describe("CIMD grant_types interop", () => {
  const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
  const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

  it("intersects MCPJam-shaped extras down to authorization_code + refresh_token", () => {
    expect(
      intersectAdvertisedGrantTypes(["authorization_code", "refresh_token", DEVICE_CODE]),
    ).toEqual(["authorization_code", "refresh_token"]);
  });

  it("also drops jwt-bearer extras", () => {
    expect(
      intersectAdvertisedGrantTypes(["authorization_code", "refresh_token", JWT_BEARER]),
    ).toEqual(["authorization_code", "refresh_token"]);
  });

  it("does not invent a supported grant when only device_code is advertised", () => {
    expect(intersectAdvertisedGrantTypes([DEVICE_CODE])).toBeUndefined();
    expect(
      rewriteClientMetadataGrantTypes({
        ...metadataDocument(),
        grant_types: [DEVICE_CODE],
      }),
    ).toBeUndefined();
  });

  it("rewrites fetched MCPJam metadata so the CIMD profile accepts it", async () => {
    const advertised = {
      ...metadataDocument(),
      grant_types: ["authorization_code", "refresh_token", DEVICE_CODE],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(advertised, { headers: { "content-type": "application/json" } }),
      ),
    );

    const res = await fetchClientMetadataResource(CLIENT_ID_URL);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.grant_types).not.toContain(DEVICE_CODE);
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
  });
});

describe("dynamic client registration (SEP-837)", () => {
  it("tolerates extra grant_types (device_code) at /oauth2/register", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP Client",
          redirect_uris: ["https://client.example.com/callback"],
          grant_types: [
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
  });

  it("tolerates the application_type field at /oauth2/register", async () => {
    const res = await app.request(
      "/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP Client",
          redirect_uris: ["https://client.example.com/callback"],
          application_type: "web",
        }),
      },
      dbEnv(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id?: string };
    expect(typeof body.client_id).toBe("string");
  });
});
