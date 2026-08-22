import { describe, expect, it } from "vitest";
import { app, rewriteDiscoveryEndpoints } from "./index";
import { ROBOTS_TXT } from "./robots";
import type { AuthEnv } from "./auth";
import { LOCAL_STACK_WEB_ORIGIN } from "./local-demo";
import { createFakeD1 } from "./test/fake-d1";

function envWithoutSecret(): AuthEnv {
  return {
    DB: {} as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "development",
    // No UPL_BETTER_AUTH_SECRET, no BETTER_AUTH_SECRET: unresolvable.
  };
}

// #731 phase C: the dev stack always runs the auth worker in same-origin
// mode now (BETTER_AUTH_URL === WEB_ORIGIN, mirroring production — see
// scripts/dev-stack.mjs), so the default local-stack shape here is the raw
// stack's pinned loopback web origin used for BOTH fields.
function localEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    BETTER_AUTH_SECRET: "x".repeat(32),
    LOCAL_STACK: "true",
    ENVIRONMENT: "development",
    BETTER_AUTH_URL: LOCAL_STACK_WEB_ORIGIN,
    WEB_ORIGIN: LOCAL_STACK_WEB_ORIGIN,
    ...overrides,
  };
}

describe("GET /health", () => {
  it("responds ok without needing auth configured", async () => {
    const response = await app.request("/health", {}, envWithoutSecret());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("GET /robots.txt", () => {
  it("disallows all crawlers on the auth host", async () => {
    const response = await app.request(
      "https://auth.uploads.sh/robots.txt",
      { method: "GET" },
      envWithoutSecret(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
    const body = await response.text();
    expect(body).toBe(ROBOTS_TXT);
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /");
  });
});

describe("503 guard", () => {
  it("answers 503 for /api/auth/* when the signing secret is unresolved", async () => {
    const response = await app.request(
      "/api/auth/get-session",
      { headers: { Origin: "https://uploads.sh" } },
      envWithoutSecret(),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_unavailable");
  });

  it("boots once BETTER_AUTH_SECRET is set", async () => {
    const env: AuthEnv = { ...envWithoutSecret(), BETTER_AUTH_SECRET: "x".repeat(32) };
    const response = await app.request(
      "/api/auth/get-session",
      { headers: { Origin: "https://uploads.sh" } },
      env,
    );
    // Not 503 — the D1 binding is a stub, so the request itself may fail
    // further downstream, but the secret-resolution guard has passed.
    expect(response.status).not.toBe(503);
  });
});

describe("CORS on /api/auth/*", () => {
  const env: AuthEnv = {
    DB: {} as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "x".repeat(32),
  };

  function preflight(origin: string) {
    return app.request(
      "/api/auth/get-session",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
        },
      },
      env,
    );
  }

  it("allows the web origin", async () => {
    const response = await preflight("https://uploads.sh");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("does not reflect an untrusted origin in production", async () => {
    const response = await preflight("https://evil.example");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not reflect localhost in production", async () => {
    const response = await preflight("http://localhost:4321");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("local demo session", () => {
  it("is absent unless every local-stack gate is exact", async () => {
    for (const env of [
      localEnv({ LOCAL_STACK: undefined }),
      localEnv({ ENVIRONMENT: "production" }),
      // #731 phase C: same-origin mode requires BETTER_AUTH_URL === WEB_ORIGIN.
      localEnv({ BETTER_AUTH_URL: "http://localhost:4321" }),
      localEnv({ WEB_ORIGIN: "http://localhost:4321" }),
    ]) {
      const res = await app.request(
        "/api/auth/dev-session",
        { method: "POST", headers: { Origin: LOCAL_STACK_WEB_ORIGIN } },
        env,
      );
      expect(res.status).toBe(404);
    }

    const wrongOrigin = await app.request(
      "/api/auth/dev-session",
      { method: "POST", headers: { Origin: "http://localhost:4321" } },
      localEnv(),
    );
    expect(wrongOrigin.status).toBe(404);
  });

  it("is absent for a same-origin pair that isn't a recognized local-stack web-origin shape", async () => {
    for (const env of [
      // Real TLD, not `.localhost` and not the pinned loopback port — never
      // enables the bypass, even though BETTER_AUTH_URL === WEB_ORIGIN here.
      localEnv({
        BETTER_AUTH_URL: "https://local.uploads.sh",
        WEB_ORIGIN: "https://local.uploads.sh",
      }),
      // Bare `.localhost` (no subdomain) doesn't match the portless shape.
      localEnv({ BETTER_AUTH_URL: "https://localhost", WEB_ORIGIN: "https://localhost" }),
    ]) {
      const res = await app.request(
        "/api/auth/dev-session",
        { method: "POST", headers: { Origin: env.WEB_ORIGIN ?? "" } },
        env,
      );
      expect(res.status).toBe(404);
    }
  });

  it("is available for a same-origin portless *.localhost pair, including worktree-prefixed", async () => {
    for (const webOrigin of ["https://uploads.localhost", "https://fix-ui.uploads.localhost"]) {
      const env = localEnv({ BETTER_AUTH_URL: webOrigin, WEB_ORIGIN: webOrigin });
      const res = await app.request(
        "/api/auth/dev-session",
        { method: "POST", headers: { Origin: webOrigin } },
        env,
      );
      expect(res.status).toBe(200);
    }
  });

  it("seeds an ordinary member and issues a standard Better Auth session", async () => {
    const env = localEnv();
    const res = await app.request(
      "/api/auth/dev-session",
      { method: "POST", headers: { Origin: LOCAL_STACK_WEB_ORIGIN } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: "local-dev-demo-user", email: "dev-demo@uploads.local", name: "Local demo" },
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    const sessionCookie = setCookie.match(/(?:^|,\s*)(better-auth\.session_token=[^;]+)/)?.[1];
    expect(sessionCookie).toBeTruthy();

    const session = await app.request(
      "/api/auth/get-session",
      { headers: { Cookie: sessionCookie ?? "" } },
      env,
    );
    expect(session.status).toBe(200);
    expect((await session.json()) as { user?: { email?: string; role?: string } }).toMatchObject({
      user: { email: "dev-demo@uploads.local", role: "user" },
    });

    const rows = env.DB as ReturnType<typeof createFakeD1>;
    expect(
      rows.__sqlite
        .prepare("SELECT role FROM member WHERE organization_id = 'local-dev-demo-org'")
        .all(),
    ).toEqual([{ role: "member" }]);
  });
});

const DISCOVERY_META_URL = "https://uploads.sh/api/auth/.well-known/oauth-authorization-server";
const discoveryMetadata = () => ({
  issuer: "https://uploads.sh/api/auth",
  authorization_endpoint: "https://uploads.sh/api/auth/oauth2/authorize",
  token_endpoint: "https://uploads.sh/api/auth/oauth2/token",
  registration_endpoint: "https://uploads.sh/api/auth/oauth2/register",
  introspection_endpoint: "https://uploads.sh/api/auth/oauth2/introspect",
  revocation_endpoint: "https://uploads.sh/api/auth/oauth2/revoke",
  jwks_uri: "https://uploads.sh/api/auth/jwks",
});
const discoveryEnv = (overrides: Partial<AuthEnv> = {}): AuthEnv => ({
  DB: {} as unknown as D1Database,
  BETTER_AUTH_URL: "https://uploads.sh",
  WEB_ORIGIN: "https://uploads.sh",
  AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh",
  ENVIRONMENT: "production",
  ...overrides,
});
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("rewriteDiscoveryEndpoints (#749)", () => {
  const META_URL = DISCOVERY_META_URL;
  const metadata = discoveryMetadata;
  const metaEnv = discoveryEnv;
  const jsonRes = jsonResponse;

  it("moves only the form-POST endpoints to the direct auth origin", async () => {
    const out = await rewriteDiscoveryEndpoints(META_URL, jsonRes(metadata()), metaEnv());
    const j = (await out.json()) as Record<string, string>;
    // Form-POST endpoints move to auth.uploads.sh …
    expect(j.token_endpoint).toBe("https://auth.uploads.sh/api/auth/oauth2/token");
    expect(j.introspection_endpoint).toBe("https://auth.uploads.sh/api/auth/oauth2/introspect");
    expect(j.revocation_endpoint).toBe("https://auth.uploads.sh/api/auth/oauth2/revoke");
    // … while issuer and the browser/JSON/GET endpoints stay same-origin.
    expect(j.issuer).toBe("https://uploads.sh/api/auth");
    expect(j.authorization_endpoint).toBe("https://uploads.sh/api/auth/oauth2/authorize");
    expect(j.registration_endpoint).toBe("https://uploads.sh/api/auth/oauth2/register");
    expect(j.jwks_uri).toBe("https://uploads.sh/api/auth/jwks");
  });

  it("is a no-op when AUTH_DIRECT_ORIGIN is unset (dev/preview)", async () => {
    const out = await rewriteDiscoveryEndpoints(
      META_URL,
      jsonRes(metadata()),
      metaEnv({ AUTH_DIRECT_ORIGIN: undefined }),
    );
    expect(((await out.json()) as Record<string, string>).token_endpoint).toBe(
      "https://uploads.sh/api/auth/oauth2/token",
    );
  });

  it("is a no-op for non-discovery paths (never reads the body)", async () => {
    const res = jsonRes({ access_token: "x" });
    const out = await rewriteDiscoveryEndpoints(
      "https://uploads.sh/api/auth/oauth2/token",
      res,
      metaEnv(),
    );
    expect(out).toBe(res); // same Response instance, untouched
  });

  it("does not rewrite a lookalike host that only shares the issuer prefix", async () => {
    const out = await rewriteDiscoveryEndpoints(
      DISCOVERY_META_URL,
      jsonResponse({
        ...discoveryMetadata(),
        token_endpoint: "https://uploads.sh.evil/api/auth/oauth2/token",
      }),
      discoveryEnv(),
    );
    const j = (await out.json()) as Record<string, string>;
    // The lookalike is left untouched; the genuine endpoints still move.
    expect(j.token_endpoint).toBe("https://uploads.sh.evil/api/auth/oauth2/token");
    expect(j.revocation_endpoint).toBe("https://auth.uploads.sh/api/auth/oauth2/revoke");
  });

  it("is a no-op when the direct origin equals the issuer origin", async () => {
    const out = await rewriteDiscoveryEndpoints(
      META_URL,
      jsonRes(metadata()),
      metaEnv({ AUTH_DIRECT_ORIGIN: "https://uploads.sh" }),
    );
    expect(((await out.json()) as Record<string, string>).token_endpoint).toBe(
      "https://uploads.sh/api/auth/oauth2/token",
    );
  });
});
