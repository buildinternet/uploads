import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { githubWebhook } from "./github-webhook";
import { FakeKv } from "../../test/fake-kv";

const SECRET = "shh";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/v1/github/webhook", githubWebhook)
    .onError((err, c) => respondError(c, err));
}

function post(body: string, headers: Record<string, string>, env: Env) {
  return app().request(
    "/v1/github/webhook",
    { method: "POST", body, headers: { "content-type": "application/json", ...headers } },
    env,
  );
}

describe("POST /v1/github/webhook", () => {
  it("503s when the secret is unset", async () => {
    const env = { GITHUB_CACHE: new FakeKv() } as unknown as Env;
    expect((await post("{}", {}, env)).status).toBe(503);
  });

  it("401s on a missing or bad signature", async () => {
    const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_CACHE: new FakeKv() } as unknown as Env;
    expect((await post("{}", {}, env)).status).toBe(401);
    expect((await post("{}", { "x-hub-signature-256": "sha256=bad" }, env)).status).toBe(401);
  });

  it("204s a valid delivery and invalidates the ref cache", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:owner/repo#7", { value: "{}" });
    const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_CACHE: kv } as unknown as Env;
    const body = JSON.stringify({
      action: "edited",
      repository: { full_name: "Owner/Repo" },
      issue: { number: 7 },
    });
    const res = await post(
      body,
      { "x-hub-signature-256": sign(body), "x-github-event": "issues" },
      env,
    );
    expect(res.status).toBe(204);
    expect(kv.store.has("ghref:owner/repo#7")).toBe(false);
  });

  it("204s a ping without touching the cache", async () => {
    const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_CACHE: new FakeKv() } as unknown as Env;
    const body = "{}";
    const res = await post(
      body,
      { "x-hub-signature-256": sign(body), "x-github-event": "ping" },
      env,
    );
    expect(res.status).toBe(204);
  });
});
