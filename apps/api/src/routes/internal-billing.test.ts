import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeRegistry } from "../../test/fake-kv";
import { respondError } from "../error-response";
import { internalBilling } from "./internal-billing";

const SECRET = "shh-internal";

// crypto.subtle.timingSafeEqual is a Workers-only extension absent from this
// repo's plain-Node vitest runtime — same polyfill as test/routes-key-policy.test.ts
// et al., needed because the route reuses admin.ts's timing-safe compare pattern.
beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/internal/billing", internalBilling)
    .onError((err, c) => respondError(c, err));
}

function post(body: unknown, headers: Record<string, string>, env: Env) {
  return app().request(
    "/internal/billing/plan",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    },
    env,
  );
}

function envWith(opts: { secret?: string; record?: Record<string, unknown> } = {}) {
  const registry = fakeRegistry(opts.record ? { acme: opts.record } : {});
  const store = registry.store;
  const env = {
    REGISTRY: registry,
    ...(opts.secret !== undefined ? { BILLING_INTERNAL_KEY: opts.secret } : {}),
  } as unknown as Env;
  return { env, store };
}

describe("POST /internal/billing/plan", () => {
  it("401s when BILLING_INTERNAL_KEY is unset, regardless of the header sent", async () => {
    const { env } = envWith({ record: { provider: "r2", bucket: "b", prefix: "acme/" } });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": "anything" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s on a wrong key", async () => {
    const { env } = envWith({
      secret: SECRET,
      record: { provider: "r2", bucket: "b", prefix: "acme/" },
    });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": "wrong" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s when the header is missing", async () => {
    const { env } = envWith({
      secret: SECRET,
      record: { provider: "r2", bucket: "b", prefix: "acme/" },
    });
    const res = await post({ workspace: "acme", plan: "pro" }, {}, env);
    expect(res.status).toBe(401);
  });

  it("400s an invalid plan value", async () => {
    const { env } = envWith({
      secret: SECRET,
      record: { provider: "r2", bucket: "b", prefix: "acme/" },
    });
    const res = await post(
      { workspace: "acme", plan: "enterprise" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_plan");
  });

  it("400s a missing workspace field", async () => {
    const { env } = envWith({ secret: SECRET });
    const res = await post({ plan: "pro" }, { "x-internal-billing-key": SECRET }, env);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_workspace");
  });

  it("404s an unknown workspace", async () => {
    const { env } = envWith({ secret: SECRET });
    const res = await post(
      { workspace: "ghost", plan: "pro" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("204s and sets the plan on the record", async () => {
    const { env, store } = envWith({
      secret: SECRET,
      record: { provider: "r2", bucket: "b", prefix: "acme/" },
    });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(204);
    expect(JSON.parse(store.get("ws:acme")!).plan).toBe("pro");
  });

  it("204s and preserves other fields, including explicit limit overrides", async () => {
    const { env, store } = envWith({
      secret: SECRET,
      record: {
        provider: "r2",
        bucket: "b",
        prefix: "acme/",
        maxStorageBytes: 123_456,
        maxUploadsPerPeriod: 42,
        githubCommentLinkToFilePage: true,
      },
    });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(204);
    const stored = JSON.parse(store.get("ws:acme")!);
    expect(stored).toMatchObject({
      provider: "r2",
      bucket: "b",
      prefix: "acme/",
      maxStorageBytes: 123_456,
      maxUploadsPerPeriod: 42,
      githubCommentLinkToFilePage: true,
      plan: "pro",
    });
  });
});
