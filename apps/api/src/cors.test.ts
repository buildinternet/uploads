/**
 * CORS mounting on the root app. The subtle one is `/v1/workspaces`: it is
 * the only `/v1/*` route authenticated by session COOKIE (self-serve creation
 * from the signed-in console at WEB_ORIGIN), so its preflight must be
 * credentialed — without `Access-Control-Allow-Credentials` the browser
 * drops the request entirely ("Failed to fetch") and self-serve creation
 * silently breaks in prod. The rest of `/v1/*` is bearer-token-authenticated
 * and deliberately stays uncredentialed.
 */
import { describe, expect, it } from "vitest";
import { app } from "./index";

const env = {} as unknown as Env;

function preflight(path: string) {
  return app.request(
    `https://api.uploads.sh${path}`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://uploads.sh",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    },
    env,
  );
}

describe("CORS preflights from the web origin", () => {
  it("credentials the cookie-authenticated /v1/workspaces route", async () => {
    const res = await preflight("/v1/workspaces");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("credentials the #249 lifecycle subroutes, DELETE included", async () => {
    const del = await app.request(
      "https://api.uploads.sh/v1/workspaces/acme",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://uploads.sh",
          "Access-Control-Request-Method": "DELETE",
        },
      },
      env,
    );
    expect(del.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(del.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    const restore = await preflight("/v1/workspaces/acme/restore");
    expect(restore.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("keeps bearer-token /v1 routes uncredentialed", async () => {
    const res = await preflight("/v1/tokens");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("keeps the cookie-authenticated /me surface credentialed", async () => {
    const res = await preflight("/me/workspaces");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("allows PATCH on admin-ui (workspace limits + oauth client edits)", async () => {
    const res = await app.request(
      "https://api.uploads.sh/admin-ui/workspaces/ryan/limits",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://uploads.sh",
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });

  it("allows PATCH on /me (member role + file visibility)", async () => {
    const res = await app.request(
      "https://api.uploads.sh/me/workspaces/acme/members/user_1",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://uploads.sh",
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });
});
