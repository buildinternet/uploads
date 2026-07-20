import { describe, expect, it } from "vitest";
import { app } from "./index";
import { FakeKv } from "../test/fake-kv";

describe("webhook route mounting", () => {
  it("reaches the webhook handler (503), not the workspace guard, for /v1/github/webhook", async () => {
    // No GITHUB_APP_WEBHOOK_SECRET → the webhook handler returns 503. A 401
    // (workspaceAuth) or 404 (notFound) would mean the route is misordered.
    const res = await app.request(
      "/v1/github/webhook",
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
      { GITHUB_CACHE: new FakeKv() } as unknown as Env,
    );
    expect(res.status).toBe(503);
  });
});
