/**
 * CORS mounting on the root app. #731 phase E: the api exposes a single
 * UNCREDENTIALED browser CORS surface. Every cookie-authenticated route
 * (`/me`, `/admin-ui`, and the cookie-authed `/v1/workspaces`+`/v1/tokens`
 * self-serve/mint surfaces) is reached by the browser same-origin through web's
 * `/api` proxy over the service binding, so none of them advertise
 * `Access-Control-Allow-Credentials` any more. The web origin (and, outside
 * production, dev loopback) is still reflected for token-authenticated
 * cross-origin calls; PATCH/DELETE stay allowed.
 */
import { describe, expect, it } from "vitest";
import { app } from "./index";

const env = {} as unknown as Env;

function preflight(path: string, method = "POST") {
  return app.request(
    `https://api.uploads.sh${path}`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://uploads.sh",
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type",
      },
    },
    env,
  );
}

describe("CORS preflights from the web origin", () => {
  it("reflects the web origin, uncredentialed, on the /v1/workspaces route", async () => {
    const res = await preflight("/v1/workspaces");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("keeps DELETE on the #249 lifecycle subroutes, uncredentialed", async () => {
    const del = await preflight("/v1/workspaces/acme", "DELETE");
    expect(del.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(del.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    const restore = await preflight("/v1/workspaces/acme/restore");
    expect(restore.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(restore.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("reflects the /v1/tokens mint surface, uncredentialed", async () => {
    const res = await preflight("/v1/tokens");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const issued = await preflight("/v1/tokens/issued", "GET");
    expect(issued.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("keeps bearer-token /v1 routes reflected and uncredentialed", async () => {
    const res = await preflight("/v1/acme/files");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("reflects the /me surface, uncredentialed", async () => {
    const res = await preflight("/me/workspaces", "GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("allows PATCH on admin-ui (workspace limits + oauth client edits), uncredentialed", async () => {
    const res = await preflight("/admin-ui/workspaces/ryan/limits", "PATCH");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });

  it("allows PATCH on /me (member role + file visibility), uncredentialed", async () => {
    const res = await preflight("/me/workspaces/acme/members/user_1", "PATCH");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });

  it("rejects a non-web origin", async () => {
    const res = await app.request(
      "https://api.uploads.sh/me/workspaces",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "GET",
        },
      },
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// Loopback origins (http://localhost[:port], http://127.0.0.1[:port]) are
// reflected outside production for local dev convenience, but never in
// production — a local page holding a victim's uploads.sh session cookie must
// not be reflected. (With credentialed CORS now retired the cookie can't ride
// a cross-origin request at all, but keep the origin gate as defense in depth.)
describe("loopback origin reflection is gated by ENVIRONMENT", () => {
  function loopbackPreflight(path: string, env: Record<string, unknown>) {
    return app.request(
      `https://api.uploads.sh${path}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "GET",
        },
      },
      env as unknown as Env,
    );
  }

  it.each(["/me/workspaces", "/v1/workspaces", "/v1/tokens"])(
    "does not reflect localhost on %s in production",
    async (path) => {
      const res = await loopbackPreflight(path, { ENVIRONMENT: "production" });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );

  it.each(["/me/workspaces", "/v1/workspaces", "/v1/tokens"])(
    "reflects localhost on %s (uncredentialed) when ENVIRONMENT is unset (dev)",
    async (path) => {
      const res = await loopbackPreflight(path, {});
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    },
  );

  it("still reflects the configured WEB_ORIGIN in production", async () => {
    const res = await app.request(
      "https://api.uploads.sh/v1/workspaces",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://uploads.sh",
          "Access-Control-Request-Method": "POST",
        },
      },
      { ENVIRONMENT: "production" } as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
