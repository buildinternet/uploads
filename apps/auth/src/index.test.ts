import { describe, expect, it } from "vitest";
import { app } from "./index";
import type { AuthEnv } from "./auth";

function envWithoutSecret(): AuthEnv {
  return {
    DB: {} as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.sh",
    ENVIRONMENT: "development",
    // No UPL_BETTER_AUTH_SECRET, no BETTER_AUTH_SECRET_DEV: unresolvable.
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
