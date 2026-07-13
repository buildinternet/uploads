import { describe, expect, it } from "vitest";
import { app } from "./index";
import type { AuthEnv } from "./auth";
import { LOCAL_STACK_AUTH_ORIGIN, LOCAL_STACK_WEB_ORIGIN } from "./local-demo";
import { createFakeD1 } from "./test/fake-d1";

function envWithoutSecret(): AuthEnv {
  return {
    DB: {} as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "development",
    // No UPL_BETTER_AUTH_SECRET, no BETTER_AUTH_SECRET_DEV: unresolvable.
  };
}

function localEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    BETTER_AUTH_SECRET_DEV: "x".repeat(32),
    LOCAL_STACK: "true",
    ENVIRONMENT: "development",
    BETTER_AUTH_URL: LOCAL_STACK_AUTH_ORIGIN,
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

  it("boots once BETTER_AUTH_SECRET_DEV is set", async () => {
    const env: AuthEnv = { ...envWithoutSecret(), BETTER_AUTH_SECRET_DEV: "x".repeat(32) };
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
    BETTER_AUTH_SECRET_DEV: "x".repeat(32),
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
      localEnv({ BETTER_AUTH_URL: "http://localhost:8788" }),
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
    const sessionCookie = setCookie.match(/(?:^|,\\s*)(better-auth\\.session_token=[^;]+)/)?.[1];
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
