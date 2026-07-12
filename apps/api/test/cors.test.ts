import { describe, expect, it } from "vitest";
import { app } from "../src/index";

const env = { WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;

function preflight(path: string, origin: string) {
  return app.request(
    path,
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
    env,
  );
}

describe("console CORS", () => {
  it("answers the preflight for the web origin on /admin", async () => {
    const response = await preflight("/admin/enrollments", "https://uploads.sh");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "authorization",
    );
  });

  it("answers the preflight for local dev origins on /v1", async () => {
    const response = await preflight("/v1/default/usage", "http://localhost:4321");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");
  });

  it("does not reflect arbitrary origins", async () => {
    const response = await preflight("/admin/enrollments", "https://evil.example");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("adds the allow-origin header to actual admin responses", async () => {
    const response = await app.request(
      "/admin/enrollments",
      { method: "POST", headers: { Origin: "https://uploads.sh" }, body: "{}" },
      env,
    );
    // Unauthorized without a token, but the CORS header must still be present
    // so the browser can read the error body.
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://uploads.sh");
  });
});
