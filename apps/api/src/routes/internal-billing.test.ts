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

  it("204s and preserves other fields, including custom explicit limit overrides", async () => {
    const { env, store } = envWith({
      secret: SECRET,
      record: {
        provider: "r2",
        bucket: "b",
        prefix: "acme/",
        // Not self-serve — and neither value matches a plan default at any
        // rate, so both must survive untouched regardless.
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

  it("issue #454: clears a self-serve record's explicit overrides that exactly equal the OLD (free) plan defaults on upgrade", async () => {
    const { env, store } = envWith({
      secret: SECRET,
      record: {
        provider: "r2",
        bucket: "b",
        prefix: "acme/",
        selfServe: true,
        // Pre-backfill self-serve record: still carries the old
        // selfServeWorkspaceRecord-stamped free defaults.
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      },
    });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(204);
    const stored = JSON.parse(store.get("ws:acme")!);
    expect(stored.plan).toBe("pro");
    expect(stored).not.toHaveProperty("maxStorageBytes");
    expect(stored).not.toHaveProperty("maxUploadsPerPeriod");
    expect(stored).not.toHaveProperty("maxUploadBytes");
    expect(stored).not.toHaveProperty("maxVideoUploadBytes");
  });

  it("issue #454: preserves a self-serve record's genuinely custom override (comped, doesn't match a plan default)", async () => {
    const { env, store } = envWith({
      secret: SECRET,
      record: {
        provider: "r2",
        bucket: "b",
        prefix: "acme/",
        selfServe: true,
        maxStorageBytes: 999_000_000, // comped — doesn't match free's default
        maxUploadsPerPeriod: 3000, // matches free's default — gets cleared
      },
    });
    const res = await post(
      { workspace: "acme", plan: "pro" },
      { "x-internal-billing-key": SECRET },
      env,
    );
    expect(res.status).toBe(204);
    const stored = JSON.parse(store.get("ws:acme")!);
    expect(stored.plan).toBe("pro");
    expect(stored.maxStorageBytes).toBe(999_000_000);
    expect(stored).not.toHaveProperty("maxUploadsPerPeriod");
  });
});

describe("GET /internal/billing/member-cap", () => {
  function get(workspace: string | null, headers: Record<string, string>, env: Env) {
    const path =
      workspace === null
        ? "/internal/billing/member-cap"
        : `/internal/billing/member-cap?workspace=${encodeURIComponent(workspace)}`;
    return app().request(path, { headers }, env);
  }

  async function capFor(record: Record<string, unknown> | undefined, name = "acme") {
    const registry = fakeRegistry(record ? { [name]: record } : {});
    const env = { REGISTRY: registry, BILLING_INTERNAL_KEY: SECRET } as unknown as Env;
    const res = await get(name, { "x-internal-billing-key": SECRET }, env);
    expect(res.status).toBe(200);
    return (await res.json()) as { workspace: string; cap: number | null; message: string | null };
  }

  it("401s when the key is unset, regardless of the header sent", async () => {
    const { env } = envWith({ record: { provider: "r2", bucket: "b", prefix: "acme/" } });
    const res = await get("acme", { "x-internal-billing-key": "anything" }, env);
    expect(res.status).toBe(401);
  });

  it("401s on a wrong key", async () => {
    const { env } = envWith({ secret: SECRET, record: { provider: "r2", bucket: "b" } });
    const res = await get("acme", { "x-internal-billing-key": "wrong" }, env);
    expect(res.status).toBe(401);
  });

  it("400s when the workspace query param is missing", async () => {
    const { env } = envWith({ secret: SECRET });
    const res = await get(null, { "x-internal-billing-key": SECRET }, env);
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_workspace");
  });

  it("caps a self-serve workspace at free's default and nudges toward Pro", async () => {
    const body = await capFor({ provider: "r2", bucket: "b", prefix: "acme/", selfServe: true });
    expect(body.cap).toBe(3);
    expect(body.message).toBe("Free workspaces include 3 members — upgrade to Pro for more.");
  });

  it("applies pro's unmarketed guard without an upsell", async () => {
    const body = await capFor({ provider: "r2", bucket: "b", selfServe: true, plan: "pro" });
    expect(body.cap).toBe(25);
    expect(body.message).toBe("This workspace includes 25 members.");
  });

  it("honors a comped per-workspace override", async () => {
    const body = await capFor({ provider: "r2", bucket: "b", selfServe: true, maxMembers: 10 });
    expect(body.cap).toBe(10);
    expect(body.message).toBe("This workspace includes 10 members.");
  });

  it("reports unlimited for a legacy operator-provisioned workspace", async () => {
    const body = await capFor({ provider: "r2", bucket: "b", prefix: "acme/" });
    expect(body.cap).toBeNull();
    expect(body.message).toBeNull();
  });

  it("exempts the communal default workspace even if a plan is stamped on it", async () => {
    const registry = fakeRegistry({
      default: { provider: "r2", bucket: "b", plan: "free", selfServe: true },
    });
    const env = { REGISTRY: registry, BILLING_INTERNAL_KEY: SECRET } as unknown as Env;
    const res = await get("default", { "x-internal-billing-key": SECRET }, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { cap: number | null }).toMatchObject({ cap: null });
  });

  it("reports unlimited (not 404) for an unknown workspace — the invite path fails open", async () => {
    const body = await capFor(undefined, "ghost");
    expect(body.cap).toBeNull();
  });
});
