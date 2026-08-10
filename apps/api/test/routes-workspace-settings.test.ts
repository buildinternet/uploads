/**
 * Canonical comment-settings, storage, and billing/summary verticals (issue
 * #613 phase 3): `/v1/workspaces/:workspace/comment-settings`, `/storage`,
 * `/storage/verify`, `/summary`, `/billing`. Exercised through the real
 * composed `app` (index.ts) — same style as `routes-workspace-members.test.ts`
 * (phase 3, invites/members).
 */
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import {
  setStorageReconcileForTests,
  setStorageVerifyForTests,
} from "../src/routes/workspace-storage";
import { fakeRegistry } from "./fake-kv";
import { UsageFakeD1 } from "./usage-fake-d1";

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin" };
const MEMBER = { id: "u-member", email: "member@example.com", name: "Member" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

interface EnvOpts {
  /** `undefined` = no session cookie sent at all. `null` = signed-out (401). */
  sessionUser?: typeof ADMIN | typeof MEMBER | null;
  role?: string;
  /** Empty array = not a member (uniform 404 posture everywhere in this vertical). */
  noMembership?: boolean;
  record?: unknown;
  subscription?: unknown;
  usage?: { objects: number; bytes?: number };
  getSessionCalls?: { count: number };
  secretsKey?: string;
  writeLimiterOk?: boolean;
}

const SHARED_RECORD = { provider: "r2", bucket: "uploads-default", prefix: "acme/" };

function makeEnv(opts: EnvOpts = {}) {
  const {
    sessionUser = ADMIN,
    role = "admin",
    noMembership = false,
    record = SHARED_RECORD,
    subscription = null,
    usage,
    getSessionCalls,
    secretsKey = "test-workspace-secrets-key-0000",
    writeLimiterOk = true,
  } = opts;

  const db = new UsageFakeD1();
  if (usage) {
    db.usage.set("acme", {
      workspace: "acme",
      bytes: usage.bytes ?? 0,
      objects: usage.objects,
      uploads_in_period: 0,
      period_start: "2026-07",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
  }

  const auth = stubAuth(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      if (getSessionCalls) getSessionCalls.count++;
      return sessionUser
        ? Response.json({ session: {}, user: sessionUser })
        : new Response(null, { status: 401 });
    }
    if (url.pathname === "/internal/memberships") {
      return Response.json(
        noMembership
          ? []
          : [{ organizationId: "org-1", organizationSlug: "acme", organizationName: "Acme", role }],
      );
    }
    if (url.pathname === "/internal/orgs/acme/subscription") {
      return Response.json({ subscription });
    }
    return new Response(null, { status: 404 });
  });

  const registry = fakeRegistry(record !== undefined ? { acme: record } : {});

  return {
    env: {
      AUTH: auth,
      DB: db,
      REGISTRY: registry,
      WORKSPACE_SECRETS_KEY: secretsKey,
      WRITE_LIMITER: { limit: async () => ({ success: writeLimiterOk }) },
    } as unknown as Env,
    registry,
    db,
  };
}

const sessionHeaders = { cookie: "session=x" };
const bearerHeaders = { Authorization: "Bearer up_acme_whatever" };

describe("GET /v1/workspaces/:workspace/summary", () => {
  it("200s for a plain member", async () => {
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member" });
    const res = await app.request("/v1/workspaces/acme/summary", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string; role: string };
    expect(body.workspace).toBe("acme");
    expect(body.role).toBe("member");
  });

  it("404s a non-member session", async () => {
    const { env } = makeEnv({ noMembership: true });
    const res = await app.request("/v1/workspaces/acme/summary", { headers: sessionHeaders }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
  });

  it("403s a bearer token with a coded error", async () => {
    const { env } = makeEnv();
    const res = await app.request("/v1/workspaces/acme/summary", { headers: bearerHeaders }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "billing_requires_session",
    );
  });

  it("401s with neither a bearer token nor a session", async () => {
    const { env } = makeEnv({ sessionUser: null });
    const res = await app.request("/v1/workspaces/acme/summary", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/workspaces/:workspace/billing", () => {
  it("200s for a plain member and never leaks stripeCustomerId", async () => {
    const { env } = makeEnv({
      sessionUser: MEMBER,
      role: "member",
      record: { ...SHARED_RECORD, plan: "pro" },
      subscription: {
        status: "active",
        periodEnd: "2026-08-15T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        stripeCustomerId: "cus_123",
        plan: "pro",
      },
    });
    const res = await app.request("/v1/workspaces/acme/billing", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("cus_123");
    expect(raw).not.toContain("stripeCustomerId");
    const body = JSON.parse(raw) as { plan: string; subscription: Record<string, unknown> | null };
    expect(body.plan).toBe("pro");
    expect(body.subscription).not.toHaveProperty("stripeCustomerId");
  });

  it("404s a non-member session", async () => {
    const { env } = makeEnv({ noMembership: true });
    const res = await app.request("/v1/workspaces/acme/billing", { headers: sessionHeaders }, env);
    expect(res.status).toBe(404);
  });

  it("403s a bearer token", async () => {
    const { env } = makeEnv();
    const res = await app.request("/v1/workspaces/acme/billing", { headers: bearerHeaders }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "billing_requires_session",
    );
  });
});

describe("GET/PATCH /v1/workspaces/:workspace/comment-settings", () => {
  it("GET 200s for an admin session", async () => {
    const { env } = makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageWidth: null,
      maxInlineImages: null,
      showMetadata: null,
      linkToFilePage: null,
      note: null,
    });
  });

  it("GET 403s a non-admin member session", async () => {
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );
  });

  it("GET 404s a non-member session", async () => {
    const { env } = makeEnv({ noMembership: true });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("GET 403s a bearer token with a coded error", async () => {
    const { env } = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      { headers: bearerHeaders },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "settings_requires_session",
    );
  });

  it("PATCH sets fields and echoes the new state for an owner session", async () => {
    const { env, registry } = makeEnv({ role: "owner" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ imageWidth: "full", note: "Hi" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imageWidth: "full", note: "Hi" });
    expect(registry.record<{ githubCommentNote?: string }>("acme")?.githubCommentNote).toBe("Hi");
  });

  it("PATCH 403s a bearer token", async () => {
    const { env } = makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...bearerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ note: "Hi" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "settings_requires_session",
    );
  });

  it("PATCH rejects an invalid field with 400", async () => {
    const { env } = makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ imageWidth: 1 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("storage vertical (self-serve BYO bucket)", () => {
  const BYO_RECORD = {
    provider: "r2",
    bucket: "customer-bucket",
    accountId: "a".repeat(32),
    accessKeyId: "enc:v1:sealed-key-id",
    secretAccessKey: "enc:v1:already-sealed",
    publicBaseUrl: "https://media.example.com",
    byoBucketEnabled: true,
    storageConfiguredAt: "2026-01-01T00:00:00.000Z",
    storageVerifiedAt: "2026-01-01T00:00:00.000Z",
    storageConfiguredBy: "u-plain",
    storageAccessKeyIdLast4: "1234",
  };

  const okVerifyResult = {
    ok: true,
    checks: [
      { id: "shape", ok: true, required: true },
      { id: "auth", ok: true, required: true },
      { id: "round-trip", ok: true, required: true },
      { id: "not-empty", ok: true, required: true },
    ],
  };

  const CANDIDATE_BODY = {
    bucket: "customer-bucket",
    accountId: "a".repeat(32),
    accessKeyId: "AKIDEXAMPLE1234",
    secretAccessKey: "super-secret-value",
    publicBaseUrl: "https://media.example.com",
  };

  afterEach(() => {
    setStorageVerifyForTests(undefined);
    setStorageReconcileForTests(undefined);
  });

  describe("GET /v1/workspaces/:workspace/storage", () => {
    it("reports byo mode with masked credentials and no secret values anywhere in the payload", async () => {
      const { env } = makeEnv({ role: "owner", record: BYO_RECORD });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("sealed-key-id");
      expect(raw).not.toContain("already-sealed");
      expect(raw).not.toContain("enc:v1:");
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body).not.toHaveProperty("accessKeyId");
      expect(body).not.toHaveProperty("secretAccessKey");
      expect(body).toMatchObject({ mode: "byo", accessKeyIdLast4: "1234" });
    });

    it("403s a non-admin member session", async () => {
      const { env } = makeEnv({ sessionUser: MEMBER, role: "member" });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(403);
    });

    it("404s a non-member session", async () => {
      const { env } = makeEnv({ noMembership: true });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(404);
    });

    it("403s a bearer token with a coded error", async () => {
      const { env } = makeEnv();
      const res = await app.request("/v1/workspaces/acme/storage", { headers: bearerHeaders }, env);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "settings_requires_session",
      );
    });
  });

  describe("POST /v1/workspaces/:workspace/storage/verify", () => {
    it("403s (byo_bucket_disabled) when the workspace flag is off", async () => {
      const { env } = makeEnv({ role: "owner", record: SHARED_RECORD });
      const res = await app.request(
        "/v1/workspaces/acme/storage/verify",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "byo_bucket_disabled",
      );
    });

    it("runs the injected verify pipeline and persists nothing", async () => {
      const { env, registry } = makeEnv({ role: "owner", record: BYO_RECORD });
      setStorageVerifyForTests(async (candidate) => {
        expect(candidate.bucket).toBe("customer-bucket");
        return okVerifyResult;
      });
      const before = registry.record("acme");
      const res = await app.request(
        "/v1/workspaces/acme/storage/verify",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(okVerifyResult);
      expect(registry.record("acme")).toEqual(before);
    });

    it("403s a bearer token", async () => {
      const { env } = makeEnv({ record: BYO_RECORD });
      const res = await app.request(
        "/v1/workspaces/acme/storage/verify",
        {
          method: "POST",
          headers: { ...bearerHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "settings_requires_session",
      );
    });
  });

  describe("PUT /v1/workspaces/:workspace/storage", () => {
    it("saves on a passing verify, masking credentials in the response", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("super-secret-value");
      const body = JSON.parse(raw) as { mode: string };
      expect(body.mode).toBe("byo");
      expect(registry.record<{ accessKeyId?: string }>("acme")?.accessKeyId).not.toBe(
        "AKIDEXAMPLE1234",
      );
    });

    it("rejects with the verify result (422) on a failed verify, leaving the record untouched", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
      });
      const failResult = {
        ok: false,
        checks: [{ id: "auth", ok: false, required: true, hint: "rejected" }],
      };
      setStorageVerifyForTests(async () => failResult);
      const before = registry.record("acme");
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(422);
      expect(registry.record("acme")).toEqual(before);
    });

    it("403s a bearer token", async () => {
      const { env } = makeEnv({ record: { ...SHARED_RECORD, byoBucketEnabled: true } });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...bearerHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /v1/workspaces/:workspace/storage", () => {
    it("detaches and restores shared-bucket defaults", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: BYO_RECORD,
        usage: { objects: 0 },
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: "shared" });
      const saved = registry.record<{ accessKeyId?: unknown }>("acme");
      expect(saved?.accessKeyId).toBeUndefined();
    });

    it("rejects detach when the bucket still has files and force wasn't passed", async () => {
      const { env } = makeEnv({ role: "owner", record: BYO_RECORD, usage: { objects: 2 } });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(409);
    });

    it("403s a bearer token", async () => {
      const { env } = makeEnv({ record: BYO_RECORD, usage: { objects: 0 } });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { method: "DELETE", headers: bearerHeaders },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "settings_requires_session",
      );
    });
  });
});

describe("/me alias forwards (issue #613 phase 3)", () => {
  it("GET /me/workspaces/:name/summary matches the canonical shape", async () => {
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member", usage: { objects: 0 } });
    const canonical = await app.request(
      "/v1/workspaces/acme/summary",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/summary",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("GET /me/workspaces/:name/billing matches the canonical shape", async () => {
    // Seed a usage row so both responses carry its fixed updated_at; without
    // one, getWorkspaceUsage stamps each response with its own request-time
    // updatedAt and the parity comparison flakes across a millisecond tick.
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member", usage: { objects: 0 } });
    const canonical = await app.request(
      "/v1/workspaces/acme/billing",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/billing",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("GET /me/workspaces/:name/comment-settings matches the canonical shape", async () => {
    const { env } = makeEnv({ role: "admin" });
    const canonical = await app.request(
      "/v1/workspaces/acme/comment-settings",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/comment-settings",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("PATCH /me/workspaces/:name/comment-settings still works via the forward", async () => {
    const { env } = makeEnv({ role: "admin" });
    const res = await app.request(
      "/me/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ note: "via alias" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ note: "via alias" });
  });

  it("GET /me/workspaces/:name/storage matches the canonical shape", async () => {
    const BYO_RECORD = {
      provider: "r2",
      bucket: "customer-bucket",
      accountId: "a".repeat(32),
      accessKeyId: "enc:v1:sealed-key-id",
      secretAccessKey: "enc:v1:already-sealed",
      byoBucketEnabled: true,
      storageAccessKeyIdLast4: "1234",
    };
    const { env } = makeEnv({ role: "owner", record: BYO_RECORD });
    const canonical = await app.request(
      "/v1/workspaces/acme/storage",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/storage",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("resolves the session exactly once per forwarded request (summary)", async () => {
    const getSessionCalls = { count: 0 };
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member", getSessionCalls });
    const res = await app.request("/me/workspaces/acme/summary", { headers: sessionHeaders }, env);
    expect(res.status).toBe(200);
    expect(getSessionCalls.count).toBe(1);
  });

  it("resolves the session exactly once per forwarded request (comment-settings PATCH)", async () => {
    const getSessionCalls = { count: 0 };
    const { env } = makeEnv({ role: "admin", getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ note: "once" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(getSessionCalls.count).toBe(1);
  });

  it("membership rejection still applies to the forwarded alias (non-member -> 404)", async () => {
    const { env } = makeEnv({ noMembership: true });
    const res = await app.request("/me/workspaces/acme/summary", { headers: sessionHeaders }, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
  });
});
