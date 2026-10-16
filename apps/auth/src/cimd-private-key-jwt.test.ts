/**
 * CIMD `private_key_jwt` (Vercel Connect). A Client ID Metadata Document may
 * keep `private_key_jwt` when its `jwks_uri` is HTTPS on the `client_id`
 * origin; anything else falls back to public PKCE. Driven against the real
 * Better Auth handler and the fake-D1 harness, with the metadata document and
 * JWKS served through the global `fetch` seam the Workers transport uses.
 * Assertions are signed with WebCrypto (ES256) so the plugin's own
 * `verifyClientAssertion` runs end to end: signature, iss/sub, aud (both
 * token endpoint hosts), exp, and jti replay.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { __resetJwksFetchCacheForTest } from "./cimd-transport";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

const CLIENT_ID_URL = "https://connect.example.com/connectors/scl_test";
const JWKS_URL = "https://connect.example.com/issuers/iss_test/jwks.json";
const REDIRECT_URI = "https://connect.example.com/callback";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const DIRECT_TOKEN_ENDPOINT = "https://auth.uploads.sh/api/auth/oauth2/token";
const ISSUER_TOKEN_ENDPOINT = "https://uploads.sh/api/auth/oauth2/token";
const ISSUER = "https://uploads.sh/api/auth";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://uploads.sh",
    AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

/** Vercel Connect's document shape (connect.vercel.com/connectors/scl_…). */
function connectDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID_URL,
    client_name: "Vercel Connect",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "client_credentials", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: JWKS_URL,
    ...overrides,
  };
}

type SigningKey = { privateKey: CryptoKey; publicJwk: Record<string, unknown> };

async function generateSigningKey(kid = "k1"): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" },
  };
}

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signAssertion(
  key: SigningKey,
  claims: Record<string, unknown> & { aud: string | string[] },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.publicJwk.kid }));
  const payload = base64url(
    JSON.stringify({
      iss: CLIENT_ID_URL,
      sub: CLIENT_ID_URL,
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
      ...claims,
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

type Served = { document: Record<string, unknown>; jwks: unknown; cacheControl: string };

/** Serves the metadata document and JWKS by URL; records every fetched URL. */
function stubConnectFetch(served: Served) {
  const fetched: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url === CLIENT_ID_URL) {
      return Response.json(served.document, {
        headers: { "cache-control": served.cacheControl },
      });
    }
    if (url === JWKS_URL) {
      return Response.json(served.jwks, { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", impl);
  return { impl, fetched };
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
  // An empty-string override drops the default (e.g. no PKCE).
  for (const [k, v] of Object.entries(params)) if (v === "") query.delete(k);
  return app.request(`/api/auth/oauth2/authorize?${query}`, {}, env);
}

/** `grant_types` is a JSON text column on the row. */
function grantTypesOf(row: { grantTypes: unknown } | undefined): unknown {
  return typeof row?.grantTypes === "string" ? JSON.parse(row.grantTypes) : row?.grantTypes;
}

async function clientRow(env: AuthEnv) {
  const orm = drizzle(env.DB, { schema });
  const [row] = await orm
    .select()
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, CLIENT_ID_URL));
  return row;
}

async function seedUser(env: AuthEnv): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const userId = crypto.randomUUID();
  await orm.insert(schema.user).values({
    id: userId,
    name: "Connect",
    email: `connect-${userId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function hashOf(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return base64url(new Uint8Array(digest));
}

async function seedRefreshToken(env: AuthEnv, clientId = CLIENT_ID_URL): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const userId = await seedUser(env);
  const raw = `rt-${crypto.randomUUID()}`;
  await orm.insert(schema.oauthRefreshToken).values({
    id: crypto.randomUUID(),
    token: await hashOf(raw),
    clientId,
    userId,
    scopes: ["files:read", "offline_access"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
  return raw;
}

async function refreshWithAssertion(
  env: AuthEnv,
  refreshToken: string,
  assertion: string | undefined,
) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (assertion) {
    body.set("client_assertion_type", ASSERTION_TYPE);
    body.set("client_assertion", assertion);
  } else {
    body.set("client_id", CLIENT_ID_URL);
  }
  return app.request(
    DIRECT_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    env,
  );
}

/** Registers the Connect client through CIMD and returns a usable refresh token. */
async function registerConnectClient(env: AuthEnv, key: SigningKey) {
  const stub = stubConnectFetch({
    document: connectDocument(),
    jwks: { keys: [key.publicJwk] },
    cacheControl: "max-age=300",
  });
  const res = await authorize(env);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("/login");
  return { stub, refreshToken: await seedRefreshToken(env) };
}

afterEach(() => {
  __resetJwksFetchCacheForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CIMD private_key_jwt ingest", () => {
  it("persists private_key_jwt + the same-origin jwks_uri, with no secret and no client_credentials", async () => {
    const env = dbEnv();
    await registerConnectClient(env, await generateSigningKey());

    const row = await clientRow(env);
    expect(row?.clientDiscoveryId).toBe("cimd");
    expect(row?.tokenEndpointAuthMethod).toBe("private_key_jwt");
    expect(row?.jwksUri).toBe(JWKS_URL);
    expect(row?.jwks).toBeNull();
    expect(row?.clientSecret).toBeNull();
    expect(grantTypesOf(row)).toEqual(["authorization_code", "refresh_token"]);
    expect(row?.skipConsent).toBeFalsy();
    // Null → the plugin's isPKCERequired treats a confidential client as
    // PKCE-required.
    // Pinned by cimdClientRowFixups rather than left to the plugin's
    // null-means-required default.
    expect(row?.requirePKCE).toBe(true);
  });

  it("still requires PKCE at /oauth2/authorize for a private_key_jwt client", async () => {
    const env = dbEnv();
    await registerConnectClient(env, await generateSigningKey());

    const res = await authorize(env, { code_challenge: "", code_challenge_method: "" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("error_description")).toMatch(/pkce/i);
  });

  it.each([
    ["a cross-origin jwks_uri", { jwks_uri: "https://keys.other.example/jwks.json" }],
    ["an http jwks_uri", { jwks_uri: "http://connect.example.com/issuers/iss_test/jwks.json" }],
    ["a subdomain jwks_uri", { jwks_uri: "https://keys.connect.example.com/jwks.json" }],
    ["an inline jwks", { jwks_uri: undefined, jwks: { keys: [] } }],
    ["inline jwks alongside jwks_uri", { jwks: { keys: [] } }],
    ["no key material", { jwks_uri: undefined }],
  ])("falls back to public none for %s", async (_label, overrides) => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const document = connectDocument(overrides);
    for (const [k, v] of Object.entries(document)) if (v === undefined) delete document[k];
    stubConnectFetch({ document, jwks: { keys: [key.publicJwk] }, cacheControl: "max-age=300" });

    const res = await authorize(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");

    const row = await clientRow(env);
    expect(row?.tokenEndpointAuthMethod).toBe("none");
    expect(row?.jwksUri ?? null).toBeNull();
    expect(row?.jwks ?? null).toBeNull();
    expect(row?.clientSecret).toBeNull();
    expect(row?.requirePKCE).toBe(true);
    expect(grantTypesOf(row)).toEqual(["authorization_code", "refresh_token"]);
  });

  it("strips skip_consent, trusted, and client_secret from a private_key_jwt document", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    stubConnectFetch({
      document: connectDocument({ skip_consent: true, trusted: true, client_secret: "forged" }),
      jwks: { keys: [key.publicJwk] },
      cacheControl: "max-age=300",
    });
    expect((await authorize(env)).status).toBe(302);
    const row = await clientRow(env);
    expect(row?.tokenEndpointAuthMethod).toBe("private_key_jwt");
    expect(row?.skipConsent).toBeFalsy();
    expect(row?.clientSecret).toBeNull();
    expect(JSON.stringify(row?.metadata ?? null)).not.toMatch(/trusted|official/);
  });

  it("does not persist a client_credentials-only private_key_jwt document", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    stubConnectFetch({
      document: connectDocument({ grant_types: ["client_credentials"] }),
      jwks: { keys: [key.publicJwk] },
      cacheControl: "max-age=300",
    });
    const res = await authorize(env);
    expect(res.headers.get("location") ?? "").not.toContain("/login");
    expect(await clientRow(env)).toBeUndefined();
  });

  it("leaves a public CIMD client (Claude, Flowy shape) on none", async () => {
    const env = dbEnv();
    stubConnectFetch({
      document: connectDocument({ token_endpoint_auth_method: "none", jwks_uri: undefined }),
      jwks: { keys: [] },
      cacheControl: "max-age=300",
    });
    expect((await authorize(env)).status).toBe(302);
    const row = await clientRow(env);
    expect(row?.tokenEndpointAuthMethod).toBe("none");
    expect(row?.jwksUri ?? null).toBeNull();
  });
});

describe("CIMD private_key_jwt at the token endpoint", () => {
  it("accepts an assertion whose aud is the advertised token endpoint on AUTH_DIRECT_ORIGIN", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { stub, refreshToken } = await registerConnectClient(env, key);

    const res = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    // Keys came from the stored jwks_uri, through the CIMD transport.
    expect(stub.fetched).toContain(JWKS_URL);
  });

  it("accepts aud = the issuer-origin token endpoint and aud = the issuer", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);

    const first = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, { aud: ISSUER_TOKEN_ENDPOINT }),
    );
    expect(first.status).toBe(200);
    const { refresh_token: rotated } = (await first.json()) as { refresh_token: string };

    const second = await refreshWithAssertion(
      env,
      rotated,
      await signAssertion(key, { aud: ISSUER }),
    );
    expect(second.status).toBe(200);
  });

  it("rejects an aud on an origin that is not ours, and the direct origin when AUTH_DIRECT_ORIGIN is unset", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);
    const foreign = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, { aud: "https://evil.example/api/auth/oauth2/token" }),
    );
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(((await foreign.json()) as { error?: string }).error).toBe("invalid_client");

    // Without the alias the plugin only knows uploads.sh: this is the
    // interop bug the oauth-provider patch fixes.
    const devEnv = dbEnv({ AUTH_DIRECT_ORIGIN: undefined });
    const dev = await registerConnectClient(devEnv, key);
    const unaliased = await refreshWithAssertion(
      devEnv,
      dev.refreshToken,
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(unaliased.status).toBeGreaterThanOrEqual(400);
    expect(((await unaliased.json()) as { error?: string }).error).toBe("invalid_client");
  });

  it("rejects a replayed jti", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);
    const assertion = await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT });

    const first = await refreshWithAssertion(env, refreshToken, assertion);
    expect(first.status).toBe(200);
    const { refresh_token: rotated } = (await first.json()) as { refresh_token: string };

    const replay = await refreshWithAssertion(env, rotated, assertion);
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toMatch(/jti has already been used/);
  });

  it("rejects an assertion signed by a key that is not in the client's JWKS", async () => {
    const env = dbEnv();
    const { refreshToken } = await registerConnectClient(env, await generateSigningKey());
    const res = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(await generateSigningKey(), { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_client");
  });

  it("rejects iss/sub that name a different client", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);
    const res = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, {
        aud: DIRECT_TOKEN_ENDPOINT,
        iss: "https://connect.example.com/connectors/other",
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_client");
  });

  it("refuses the public (client_id only) path for a private_key_jwt client", async () => {
    const env = dbEnv();
    const { refreshToken } = await registerConnectClient(env, await generateSigningKey());
    const res = await refreshWithAssertion(env, refreshToken, undefined);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_client");
  });

  it("refuses client_credentials for the CIMD client", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    await registerConnectClient(env, key);
    const res = await app.request(
      DIRECT_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
        }).toString(),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("unauthorized_client");
  });
});

describe("CIMD private_key_jwt refresh", () => {
  it("downgrades to none when a refreshed document moves jwks_uri off-origin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const env = dbEnv();
    const key = await generateSigningKey();
    const served: Served = {
      document: connectDocument(),
      jwks: { keys: [key.publicJwk] },
      // Revalidate on every resolution.
      cacheControl: "no-store",
    };
    stubConnectFetch(served);
    expect((await authorize(env)).status).toBe(302);
    expect((await clientRow(env))?.tokenEndpointAuthMethod).toBe("private_key_jwt");
    const refreshToken = await seedRefreshToken(env);

    served.document = connectDocument({ jwks_uri: "https://keys.other.example/jwks.json" });
    // Past the resolver's per-client minimum fetch interval.
    vi.setSystemTime(new Date("2026-10-15T12:00:05Z"));
    expect((await authorize(env)).status).toBe(302);
    const downgraded = await clientRow(env);
    expect(downgraded?.tokenEndpointAuthMethod).toBe("none");
    expect(downgraded?.jwksUri ?? null).toBeNull();

    vi.setSystemTime(new Date("2026-10-15T12:00:10Z"));
    const res = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toMatch(/not registered for private_key_jwt/);
  });
});

describe("CIMD private_key_jwt authorization_code exchange", () => {
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk";

  async function seedAuthorizationCode(env: AuthEnv): Promise<string> {
    const orm = drizzle(env.DB, { schema });
    const userId = await seedUser(env);
    const sessionId = crypto.randomUUID();
    await orm.insert(schema.session).values({
      id: sessionId,
      userId,
      token: `session-${sessionId}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const code = `code-${crypto.randomUUID()}`;
    // S256 challenge = base64url(SHA-256(verifier)), same as hashOf.
    const challenge = await hashOf(VERIFIER);
    await orm.insert(schema.verification).values({
      id: crypto.randomUUID(),
      identifier: await hashOf(code),
      value: JSON.stringify({
        type: "authorization_code",
        query: {
          response_type: "code",
          client_id: CLIENT_ID_URL,
          redirect_uri: REDIRECT_URI,
          scope: "files:read",
          state: "s",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        userId,
        sessionId,
      }),
      expiresAt: new Date(Date.now() + 600 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return code;
  }

  async function exchange(env: AuthEnv, code: string, assertion: string, verifier?: string) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
    });
    if (verifier) body.set("code_verifier", verifier);
    return app.request(
      DIRECT_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      env,
    );
  }

  it("rejects a valid assertion without code_verifier", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    await registerConnectClient(env, key);
    const res = await exchange(
      env,
      await seedAuthorizationCode(env),
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/PKCE is required/);
  });

  it("issues tokens for a valid assertion plus the matching code_verifier", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    await registerConnectClient(env, key);
    const res = await exchange(
      env,
      await seedAuthorizationCode(env),
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
      VERIFIER,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { access_token?: string }).access_token).toBeTruthy();
  });
});

describe("CIMD private_key_jwt revocation", () => {
  const DIRECT_REVOKE_ENDPOINT = "https://auth.uploads.sh/api/auth/oauth2/revoke";

  async function revoke(env: AuthEnv, token: string, assertion: string) {
    return app.request(
      DIRECT_REVOKE_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          token_type_hint: "refresh_token",
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: assertion,
        }).toString(),
      },
      env,
    );
  }

  async function revokedAt(env: AuthEnv, raw: string) {
    const orm = drizzle(env.DB, { schema });
    const [row] = await orm
      .select({ revoked: schema.oauthRefreshToken.revoked })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, await hashOf(raw)));
    return row?.revoked ?? null;
  }

  it("revokes the caller's own refresh token with aud = the direct-origin revoke endpoint", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);
    const res = await revoke(
      env,
      refreshToken,
      await signAssertion(key, { aud: DIRECT_REVOKE_ENDPOINT }),
    );
    expect(res.status).toBe(200);
    expect(await revokedAt(env, refreshToken)).not.toBeNull();
  });

  it("does not revoke another client's refresh token", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    await registerConnectClient(env, key);
    const otherToken = await seedRefreshToken(env, "uploads-cli");
    await revoke(env, otherToken, await signAssertion(key, { aud: DIRECT_REVOKE_ENDPOINT }));
    expect(await revokedAt(env, otherToken)).toBeNull();
  });
});

describe("CIMD private_key_jwt key fetch hardening", () => {
  it("refuses a jwks_uri that answers with a redirect", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { refreshToken } = await registerConnectClient(env, key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === JWKS_URL) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://keys.other.example/jwks.json" },
          });
        }
        return Response.json(connectDocument(), { headers: { "cache-control": "max-age=300" } });
      }),
    );
    const res = await refreshWithAssertion(
      env,
      refreshToken,
      await signAssertion(key, { aud: DIRECT_TOKEN_ENDPOINT }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error?: string }).error).toBe("invalid_client");
  });

  it("does not refetch the JWK Set for every unknown-kid assertion", async () => {
    const env = dbEnv();
    const key = await generateSigningKey();
    const { stub, refreshToken } = await registerConnectClient(env, key);
    for (let i = 0; i < 5; i++) {
      const res = await refreshWithAssertion(
        env,
        refreshToken,
        await signAssertion(await generateSigningKey(`unknown-${i}`), {
          aud: DIRECT_TOKEN_ENDPOINT,
        }),
      );
      expect(res.status).toBe(401);
    }
    expect(stub.fetched.filter((url) => url === JWKS_URL)).toHaveLength(1);
  });
});
