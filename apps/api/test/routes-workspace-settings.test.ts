/**
 * Canonical comment-settings, storage, and billing/summary verticals (issue
 * #613 phase 3): `/v1/workspaces/:workspace/comment-settings`, `/storage`,
 * `/storage/verify`, `/summary`, `/billing`. Exercised through the real
 * composed `app` (index.ts) — same style as `routes-workspace-members.test.ts`
 * (phase 3, invites/members).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_RECORD_MAX_AGE_MS, LANE_STAMP_MAX_AGE_MS } from "../src/active-content";
import { hostActiveContentKey } from "../src/active-content-hosts";
import { app } from "../src/index";
import {
  setLaneActiveContentCheckForTests,
  setStorageReconcileForTests,
  setStorageVerifyForTests,
} from "../src/routes/workspace-storage";
import { encryptSecret } from "../src/secrets";
import { fakeRegistry } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
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
  /**
   * Flagship stand-in for the active-content gate (issue #929). Omitted = no
   * `FLAGS` binding, which the gate treats as fail-closed — every test that
   * doesn't care keeps its pre-#929 behavior.
   */
  activeContentFlag?: boolean;
}

const SHARED_RECORD = { provider: "r2", bucket: "uploads-default", prefix: "acme/" };

/**
 * The platform binding a real shared-bucket workspace carries. Spread into
 * `SHARED_RECORD` by the active-content display tests (issue #929), which
 * read the gate itself — and the gate calls a lane shared by its *binding*
 * (`isSharedLane`), not by the absence of credentials the way the masked
 * projection's `mode` does.
 */
const SHARED_LANE = { binding: "UPLOADS_DEFAULT" };

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
    activeContentFlag,
  } = opts;

  const db = new UsageFakeD1();
  if (usage) {
    db.usage.set("acme", {
      workspace: "acme",
      bytes: usage.bytes ?? 0,
      objects: usage.objects,
      shared_bytes: usage.bytes ?? 0,
      shared_objects: usage.objects,
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
      ...(activeContentFlag === undefined
        ? {}
        : { FLAGS: { getBooleanValue: async () => activeContentFlag } }),
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
      ingestGithubAttachments: null,
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

  it("PATCH round-trips ingestGithubAttachments for an owner session", async () => {
    const { env, registry } = makeEnv({ role: "owner" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ ingestGithubAttachments: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ingestGithubAttachments: true });
    expect(
      registry.record<{ githubIngestAttachments?: boolean }>("acme")?.githubIngestAttachments,
    ).toBe(true);
  });

  it("PATCH rejects a non-boolean ingestGithubAttachments with 400", async () => {
    const { env } = makeEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-settings",
      {
        method: "PATCH",
        headers: { ...sessionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ ingestGithubAttachments: "yes" }),
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

  const CANDIDATE_BODY_S3 = {
    provider: "s3",
    bucket: "s3-bucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE1234",
    secretAccessKey: "super-secret-value",
    publicBaseUrl: "https://media.example.com",
  };

  const SECRETS_KEY = "test-workspace-secrets-key-0000";

  /**
   * Real (not placeholder) sealed credentials — activate opens them for
   * the stale-verify re-check, so a fake `enc:v1:` string that isn't
   * actually valid ciphertext would 503 (`storage_credentials_unreadable`)
   * on every test that reaches a stale lane, not just the ones testing it.
   */
  async function standbyLane(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "lane_standby1",
      provider: "r2",
      bucket: "customer-bucket",
      accountId: "a".repeat(32),
      accessKeyId: await encryptSecret(SECRETS_KEY, "AKIDEXAMPLE1234"),
      secretAccessKey: await encryptSecret(SECRETS_KEY, "super-secret-value"),
      publicBaseUrl: "https://media.example.com",
      // Fresh by default — a test that wants the stale-verify path
      // overrides this with a timestamp older than LANE_VERIFY_STALE_MS.
      verifiedAt: new Date().toISOString(),
      storageAccessKeyIdLast4: "1234",
      ...overrides,
    };
  }

  afterEach(() => {
    setStorageVerifyForTests(undefined);
    setStorageReconcileForTests(undefined);
    setLaneActiveContentCheckForTests(undefined);
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

    it("projects provider/endpoint/region on an s3 lane; an r2 lane still projects accountIdMasked/jurisdiction", async () => {
      const { env } = makeEnv({
        role: "owner",
        record: {
          ...SHARED_RECORD,
          byoBucketEnabled: true,
          storageLanes: [
            {
              id: "lane_r2test",
              provider: "r2",
              bucket: "r2-bucket",
              accountId: "b".repeat(32),
              accessKeyId: "enc:v1:x",
              secretAccessKey: "enc:v1:y",
              jurisdiction: "eu",
            },
            {
              id: "lane_s3test",
              provider: "s3",
              bucket: "s3-bucket",
              endpoint: "https://s3.us-east-1.amazonaws.com",
              region: "us-east-1",
              forcePathStyle: true,
              accessKeyId: "enc:v1:x",
              secretAccessKey: "enc:v1:y",
            },
          ],
        },
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        lanes: Array<{
          laneId: string;
          provider?: string;
          endpoint?: string;
          region?: string;
          forcePathStyle?: boolean;
          accountIdMasked?: string;
          jurisdiction?: string;
        }>;
      };
      const r2Lane = body.lanes.find((l) => l.laneId === "lane_r2test");
      const s3Lane = body.lanes.find((l) => l.laneId === "lane_s3test");
      expect(r2Lane).toMatchObject({ provider: "r2", accountIdMasked: `…${"b".repeat(4)}` });
      expect(r2Lane?.endpoint).toBeUndefined();
      expect(s3Lane).toMatchObject({
        provider: "s3",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        forcePathStyle: true,
      });
      expect(s3Lane?.accountIdMasked).toBeUndefined();
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

    // "Hosted lane display" (issue #929): the pure `storageStatusResponse`
    // projection has no KV or flag access, so the active lane's row comes
    // from the gate itself (`activeContentStatus`) — the page can only ever
    // say "Verified" about a lane SVG/XML is actually accepted on, including
    // the embed twin's own host record.
    it("reflects the hosted host's active-content record on the shared active lane", async () => {
      const { env } = makeEnv({
        role: "admin",
        record: { ...SHARED_RECORD, ...SHARED_LANE, publicBaseUrl: "https://storage.uploads.sh" },
        activeContentFlag: true,
      });
      const verifiedAt = new Date(Date.now() - 1000).toISOString();
      for (const host of ["storage.uploads.sh", "embed.uploads.sh"]) {
        await env.REGISTRY.put(
          hostActiveContentKey(host),
          JSON.stringify({ ok: true, verifiedAt }),
        );
      }
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        activeContentVerifiedAt?: string;
        activeContentReason?: string;
      };
      expect(body.mode).toBe("shared");
      expect(body.activeContentVerifiedAt).toBe(verifiedAt);
      expect(body.activeContentReason).toBeUndefined();
    });

    it("reports the gate's reason on the active lane when a fresh host record isn't enough", async () => {
      // Everything the host-record check wants is in place; the kill switch
      // is off. The page must say so rather than showing "Verified <date>"
      // for uploads the gate is refusing.
      const { env } = makeEnv({
        role: "admin",
        record: { ...SHARED_RECORD, ...SHARED_LANE, publicBaseUrl: "https://storage.uploads.sh" },
        activeContentFlag: false,
      });
      const verifiedAt = new Date(Date.now() - 1000).toISOString();
      for (const host of ["storage.uploads.sh", "embed.uploads.sh"]) {
        await env.REGISTRY.put(
          hostActiveContentKey(host),
          JSON.stringify({ ok: true, verifiedAt }),
        );
      }
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      const body = (await res.json()) as {
        activeContentVerifiedAt?: string;
        activeContentReason?: string;
      };
      expect(body.activeContentVerifiedAt).toBeUndefined();
      expect(body.activeContentReason).toBe("flag_off");
    });

    it("omits activeContentVerifiedAt on a shared active lane when the host record has never probed ok", async () => {
      const { env } = makeEnv({
        role: "admin",
        record: { ...SHARED_RECORD, ...SHARED_LANE, publicBaseUrl: "https://storage.uploads.sh" },
        activeContentFlag: true,
      });
      await env.REGISTRY.put(
        hostActiveContentKey("storage.uploads.sh"),
        JSON.stringify({
          ok: false,
          verifiedAt: new Date(Date.now() - 1000).toISOString(),
          detail: "no sandbox",
        }),
      );
      // The embed twin is fine — only the stable host's failing record is
      // allowed to explain the omission.
      await env.REGISTRY.put(
        hostActiveContentKey("embed.uploads.sh"),
        JSON.stringify({ ok: true, verifiedAt: new Date(Date.now() - 1000).toISOString() }),
      );
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      const body = (await res.json()) as {
        activeContentVerifiedAt?: string;
        activeContentReason?: string;
      };
      expect(body.activeContentVerifiedAt).toBeUndefined();
      // A record that exists but failed its probe is distinct from no
      // record at all (`host_missing`) — see `active-content.ts`.
      expect(body.activeContentReason).toBe("host_not_ok");
    });

    // Item 6 (issue #929 final-review): the hosted host's record projects
    // as `verifiedAt` only within `HOST_RECORD_MAX_AGE_MS` — the same
    // freshness window `activeContentAllowed` (../src/active-content.ts)
    // enforces before it actually lets SVG/XML through. A stale-but-ok
    // record must not read as "Verified" on the settings page when the gate
    // itself has already stopped trusting it.
    it("omits activeContentVerifiedAt on a shared active lane when the host record is ok but stale (older than HOST_RECORD_MAX_AGE_MS)", async () => {
      const { env } = makeEnv({
        role: "admin",
        record: { ...SHARED_RECORD, ...SHARED_LANE, publicBaseUrl: "https://storage.uploads.sh" },
        activeContentFlag: true,
      });
      await env.REGISTRY.put(
        hostActiveContentKey("storage.uploads.sh"),
        JSON.stringify({
          ok: true,
          verifiedAt: new Date(Date.now() - (HOST_RECORD_MAX_AGE_MS + 1000)).toISOString(),
        }),
      );
      await env.REGISTRY.put(
        hostActiveContentKey("embed.uploads.sh"),
        JSON.stringify({ ok: true, verifiedAt: new Date(Date.now() - 1000).toISOString() }),
      );
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      const body = (await res.json()) as {
        activeContentVerifiedAt?: string;
        activeContentReason?: string;
      };
      expect(body.activeContentVerifiedAt).toBeUndefined();
      expect(body.activeContentReason).toBe("host_stale");
    });

    it("reflects the hosted host's active-content record on a shared entry in lanes[]", async () => {
      const { env } = makeEnv({
        role: "owner",
        record: {
          ...BYO_RECORD,
          storageLanes: [
            {
              id: "lane_sharedfallback",
              provider: "r2",
              bucket: "uploads-default",
              binding: "UPLOADS_FALLBACK",
              publicBaseUrl: "https://storage.uploads.sh",
              lastActiveAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      });
      const verifiedAt = new Date(Date.now() - 1000).toISOString();
      await env.REGISTRY.put(
        hostActiveContentKey("storage.uploads.sh"),
        JSON.stringify({ ok: true, verifiedAt }),
      );
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      const body = (await res.json()) as {
        lanes: Array<{ laneId: string; mode: string; activeContentVerifiedAt?: string }>;
      };
      const lane = body.lanes.find((l) => l.laneId === "lane_sharedfallback");
      expect(lane).toMatchObject({
        mode: "shared",
        activeContentVerifiedAt: verifiedAt,
      });
    });

    it("drops a BYO lane entry's own stamp once it is past LANE_STAMP_MAX_AGE_MS", async () => {
      // Same window the gate would apply if this lane were the active one —
      // a lapsed stamp reads as "not verified" in the list too, rather than
      // showing a date that no longer means anything (issue #929 simplify).
      const fresh = new Date(Date.now() - 1000).toISOString();
      const { env } = makeEnv({
        role: "owner",
        record: {
          ...BYO_RECORD,
          storageLanes: [
            {
              id: "lane_stale",
              provider: "r2",
              bucket: "old-bucket",
              accountId: "a".repeat(32),
              publicBaseUrl: "https://old.example.com",
              activeContentVerifiedAt: new Date(
                Date.now() - (LANE_STAMP_MAX_AGE_MS + 1000),
              ).toISOString(),
            },
            {
              id: "lane_fresh",
              provider: "r2",
              bucket: "new-bucket",
              accountId: "b".repeat(32),
              publicBaseUrl: "https://new.example.com",
              activeContentVerifiedAt: fresh,
            },
          ],
        },
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { headers: sessionHeaders },
        env,
      );
      const body = (await res.json()) as {
        lanes: Array<{ laneId: string; activeContentVerifiedAt?: string }>;
      };
      expect(
        body.lanes.find((l) => l.laneId === "lane_stale")?.activeContentVerifiedAt,
      ).toBeUndefined();
      expect(body.lanes.find((l) => l.laneId === "lane_fresh")?.activeContentVerifiedAt).toBe(
        fresh,
      );
    });
  });

  describe("POST /v1/workspaces/:workspace/storage/verify", () => {
    it("403s (byo_bucket_disabled) when the workspace flag is explicitly off", async () => {
      const { env } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: false },
      });
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

  describe("POST /v1/workspaces/:workspace/storage/buckets", () => {
    it('400s a provider:"s3" body — the bucket picker only supports r2', async () => {
      const { env, registry } = makeEnv({ role: "owner", record: BYO_RECORD });
      const before = registry.record("acme");
      const res = await app.request(
        "/v1/workspaces/acme/storage/buckets",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            provider: "s3",
            accountId: "irrelevant",
            accessKeyId: "irrelevant",
            secretAccessKey: "irrelevant",
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(registry.record("acme")).toEqual(before);
    });
  });

  describe("PUT /v1/workspaces/:workspace/storage", () => {
    it("saves a standby lane on a passing verify, masking credentials in the response, without switching the active lane", async () => {
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
      const body = JSON.parse(raw) as {
        mode: string;
        lanes: Array<{ laneId: string; role: string; bucket: string }>;
      };
      // The active lane is untouched — saving a config never switches it.
      expect(body.mode).toBe("shared");
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]).toMatchObject({ role: "standby", bucket: "customer-bucket" });
      // Top-level (active-lane) fields are untouched.
      expect(registry.record<{ bucket?: string; accessKeyId?: string }>("acme")?.bucket).toBe(
        "uploads-default",
      );
      const savedLane = registry.record<{
        storageLanes?: Array<{ accessKeyId?: string }>;
      }>("acme")?.storageLanes?.[0];
      expect(savedLane?.accessKeyId).not.toBe("AKIDEXAMPLE1234");
      expect(savedLane?.accessKeyId).toMatch(/^enc:v1:/);
    });

    it("saving again for the same bucket replaces the standby lane in place rather than appending a duplicate", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResult);
      const first = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      const firstLaneId = ((await first.json()) as { lanes: Array<{ laneId: string }> }).lanes[0]!
        .laneId;

      const second = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(second.status).toBe(200);
      const body = (await second.json()) as { lanes: Array<{ laneId: string }> };
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]!.laneId).toBe(firstLaneId);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(1);
    });

    it("saves a standby lane even on a populated workspace — saving never changes routing", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 5 },
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
      expect(registry.record<{ bucket?: string }>("acme")?.bucket).toBe("uploads-default");
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

    // CodeRabbit review (PR #774): a candidate matching the ACTIVE BYO
    // lane's own bucket+accountId is a credential rotation of that lane,
    // not a new saved config. Writing it as a standby would leave the
    // active lane's stale creds live and risk a later activate discarding
    // the rotated ones entirely.
    it("rotating the active BYO lane's own bucket+accountId updates it in place, creating no standby lane", async () => {
      const { env, registry } = makeEnv({ role: "owner", record: BYO_RECORD });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        lanes: unknown[];
        accessKeyIdLast4?: string;
      };
      // Still the active lane — no standby was created for the rotation.
      expect(body.mode).toBe("byo");
      expect(body.lanes).toHaveLength(0);
      expect(body.accessKeyIdLast4).toBe("0000");

      const saved = registry.record<{
        storageLanes?: unknown[];
        accessKeyId?: string;
        bucket?: string;
      }>("acme");
      expect(saved?.storageLanes ?? []).toHaveLength(0);
      expect(saved?.bucket).toBe("customer-bucket");
      expect(saved?.accessKeyId).not.toBe("AKIDROTATED0000");
      expect(saved?.accessKeyId).toMatch(/^enc:v1:/);
    });

    // Regression coverage: `laneIdentity` (workspace-lanes.ts) used `??`
    // between `accountId` and `endpoint`, and `candidateFromBody` stamped an
    // s3 candidate's `accountId` as `""` rather than leaving it `undefined`
    // — `"" ?? endpoint` never falls through to `endpoint`, so an s3
    // candidate's identity never matched its own active lane's, and
    // "rotate credentials" on an active s3 lane silently appended a
    // duplicate standby instead of refreshing the active lane's creds.
    it("rotating the active s3 lane's own bucket+endpoint updates it in place, creating no standby lane", async () => {
      const BYO_S3_RECORD = {
        provider: "s3",
        bucket: "s3-bucket",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: "enc:v1:sealed-key-id",
        secretAccessKey: "enc:v1:already-sealed",
        publicBaseUrl: "https://media.example.com",
        byoBucketEnabled: true,
        storageConfiguredAt: "2026-01-01T00:00:00.000Z",
        storageVerifiedAt: "2026-01-01T00:00:00.000Z",
        storageConfiguredBy: "u-plain",
        storageAccessKeyIdLast4: "1234",
      };
      const { env, registry } = makeEnv({ role: "owner", record: BYO_S3_RECORD });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY_S3, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        lanes: unknown[];
        accessKeyIdLast4?: string;
      };
      // Still the active lane — no standby was created for the rotation.
      expect(body.mode).toBe("byo");
      expect(body.lanes).toHaveLength(0);
      expect(body.accessKeyIdLast4).toBe("0000");

      const saved = registry.record<{
        storageLanes?: unknown[];
        accessKeyId?: string;
        bucket?: string;
        endpoint?: string;
      }>("acme");
      expect(saved?.storageLanes ?? []).toHaveLength(0);
      expect(saved?.bucket).toBe("s3-bucket");
      expect(saved?.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
      expect(saved?.accessKeyId).not.toBe("AKIDROTATED0000");
      expect(saved?.accessKeyId).toMatch(/^enc:v1:/);
    });

    it("saving a DIFFERENT bucket while a BYO lane is active still creates a standby, active lane untouched", async () => {
      const { env, registry } = makeEnv({ role: "owner", record: BYO_RECORD });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY, bucket: "second-bucket" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string; lanes: Array<{ bucket: string }> };
      expect(body.mode).toBe("byo");
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]).toMatchObject({ bucket: "second-bucket" });

      const saved = registry.record<{ bucket?: string; accessKeyId?: string }>("acme");
      // The active lane (original bucket) is untouched.
      expect(saved?.bucket).toBe("customer-bucket");
      expect(saved?.accessKeyId).toBe(BYO_RECORD.accessKeyId);
    });

    it("saves an s3 lane with provider/endpoint/region/forcePathStyle, sealed creds, no accountId/jurisdiction", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async (candidate) => {
        expect(candidate.provider).toBe("s3");
        expect(candidate.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
        expect(candidate.region).toBe("us-east-1");
        return okVerifyResult;
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY_S3),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        lanes: Array<{
          bucket: string;
          provider?: string;
          endpoint?: string;
          region?: string;
          accountIdMasked?: string;
        }>;
      };
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]).toMatchObject({
        bucket: "s3-bucket",
        provider: "s3",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
      });
      expect(body.lanes[0]!.accountIdMasked).toBeUndefined();

      const saved = registry.record<{
        storageLanes?: Array<{
          provider?: string;
          endpoint?: string;
          region?: string;
          forcePathStyle?: boolean;
          accountId?: string;
          jurisdiction?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
        }>;
      }>("acme");
      const savedLane = saved?.storageLanes?.[0];
      expect(savedLane).toMatchObject({
        provider: "s3",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
      });
      expect(savedLane?.accountId).toBeUndefined();
      expect(savedLane?.jurisdiction).toBeUndefined();
      expect(savedLane?.accessKeyId).toMatch(/^enc:v1:/);
      expect(savedLane?.secretAccessKey).toMatch(/^enc:v1:/);
    });

    it("saving again for the same bucket+endpoint replaces the saved s3 lane in place", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResult);
      const first = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY_S3),
        },
        env,
      );
      const firstLaneId = ((await first.json()) as { lanes: Array<{ laneId: string }> }).lanes[0]!
        .laneId;

      const second = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY_S3, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(second.status).toBe(200);
      const body = (await second.json()) as { lanes: Array<{ laneId: string }> };
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]!.laneId).toBe(firstLaneId);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(1);
    });

    it("saving the same bucket at a different endpoint creates a second s3 lane", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResult);
      await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY_S3),
        },
        env,
      );
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            ...CANDIDATE_BODY_S3,
            endpoint: "https://s3.eu-west-2.amazonaws.com",
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lanes: unknown[] };
      expect(body.lanes).toHaveLength(2);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(2);
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

    it("still detaches an already-BYO-configured workspace after byoBucketEnabled is revoked (#619)", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...BYO_RECORD, byoBucketEnabled: false },
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

    it("still 403s (byo_bucket_disabled) a shared-mode workspace with the flag off — the gate isn't just deleted", async () => {
      const { env } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: false },
        usage: { objects: 0 },
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "byo_bucket_disabled",
      );
    });

    it("force-detaching a non-empty BYO workspace keeps the config as a fallback lane instead of discarding it", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: BYO_RECORD,
        usage: { objects: 9 },
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage?force=true",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lanes: Array<{ role: string; bucket: string }> };
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]).toMatchObject({ role: "fallback", bucket: "customer-bucket" });
      const saved = registry.record<{ bucket?: string; accessKeyId?: unknown }>("acme");
      expect(saved?.bucket).toBe("uploads-default");
      expect(saved?.accessKeyId).toBeUndefined();
    });
  });

  describe("POST /v1/workspaces/:workspace/storage/activate", () => {
    it("promotes a standby lane to active and demotes the outgoing shared config to a fallback lane", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: true,
        storageLanes: [await standbyLane()],
      };
      const { env, registry } = makeEnv({ role: "owner", record });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        activeLaneId: string;
        lanes: Array<{ role: string; bucket: string; lastActiveAt?: string }>;
      };
      expect(body.mode).toBe("byo");
      expect(body.activeLaneId).toBe("lane_standby1");
      expect(body.lanes).toHaveLength(1);
      expect(body.lanes[0]).toMatchObject({ role: "fallback", bucket: "uploads-default" });
      expect(body.lanes[0]?.lastActiveAt).toBeTruthy();

      const saved = registry.record<{
        bucket?: string;
        accountId?: string;
        accessKeyId?: string;
        storageLaneId?: string;
        storageLanes?: Array<{ id: string; bucket: string; lastActiveAt?: string }>;
      }>("acme");
      expect(saved?.bucket).toBe("customer-bucket");
      expect(saved?.accountId).toBe("a".repeat(32));
      expect(saved?.storageLaneId).toBe("lane_standby1");
      expect(saved?.storageLanes).toHaveLength(1);
      expect(saved?.storageLanes?.[0]?.bucket).toBe("uploads-default");
      expect(saved?.storageLanes?.[0]?.lastActiveAt).toBeTruthy();
    });

    it("re-verifies a stale s3 lane by passing an s3 candidate (provider/endpoint/region) into verify", async () => {
      const staleS3Lane = {
        id: "lane_s3stale",
        provider: "s3",
        bucket: "s3-bucket",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
        accessKeyId: await encryptSecret(SECRETS_KEY, "AKIDEXAMPLE1234"),
        secretAccessKey: await encryptSecret(SECRETS_KEY, "super-secret-value"),
        verifiedAt: "2020-01-01T00:00:00.000Z",
        storageAccessKeyIdLast4: "1234",
      };
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [staleS3Lane] };
      const { env } = makeEnv({ role: "owner", record });
      let seenCandidate: { provider?: string; endpoint?: string; region?: string } | undefined;
      setStorageVerifyForTests(async (candidate) => {
        seenCandidate = candidate;
        return okVerifyResult;
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_s3stale" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(seenCandidate).toMatchObject({
        provider: "s3",
        endpoint: "https://s3.us-east-1.amazonaws.com",
        region: "us-east-1",
      });
    });

    it("re-verifies a stale-verified lane before switching, and 422s without mutating on failure", async () => {
      const staleLane = await standbyLane({ verifiedAt: "2020-01-01T00:00:00.000Z" });
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [staleLane] };
      const { env, registry } = makeEnv({ role: "owner", record });
      let calls = 0;
      setStorageVerifyForTests(async () => {
        calls++;
        return { ok: false, checks: [{ id: "auth", ok: false, required: true, hint: "bad" }] };
      });
      const before = registry.record("acme");
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(422);
      expect(calls).toBe(1);
      expect(registry.record("acme")).toEqual(before);
    });

    it("skips re-verify when the lane's verifiedAt is fresh", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: true,
        storageLanes: [await standbyLane()],
      };
      const { env } = makeEnv({ role: "owner", record });
      let calls = 0;
      setStorageVerifyForTests(async () => {
        calls++;
        return okVerifyResult;
      });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(calls).toBe(0);
    });

    it("switches back to a binding-mode fallback lane without requiring byoBucketEnabled", async () => {
      const sharedFallback = {
        id: "lane_shared0",
        provider: "r2",
        bucket: "uploads-default",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
        lastActiveAt: "2026-08-01T00:00:00.000Z",
      };
      const record = { ...BYO_RECORD, byoBucketEnabled: false, storageLanes: [sharedFallback] };
      const { env, registry } = makeEnv({ role: "owner", record });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_shared0" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe("shared");
      const saved = registry.record<{ bucket?: string; binding?: string }>("acme");
      expect(saved?.bucket).toBe("uploads-default");
      expect(saved?.binding).toBe("UPLOADS_DEFAULT");
    });

    it("404s an unknown laneId", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: true,
        storageLanes: [await standbyLane()],
      };
      const { env } = makeEnv({ role: "owner", record });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_nonexistent" }),
        },
        env,
      );
      expect(res.status).toBe(404);
    });

    it("403s (byo_bucket_disabled) activating an HTTP-mode lane when the flag is off", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: false,
        storageLanes: [await standbyLane()],
      };
      const { env } = makeEnv({ role: "owner", record });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "byo_bucket_disabled",
      );
    });

    it("403s a bearer token", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: true,
        storageLanes: [await standbyLane()],
      };
      const { env } = makeEnv({ record });
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...bearerHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("active-content verification stamp (issue #929)", () => {
    const okVerifyResultWithActiveContent = {
      ...okVerifyResult,
      checks: [
        ...okVerifyResult.checks,
        { id: "active-content-headers", ok: true, required: false },
      ],
    };
    const okVerifyResultWithFailedActiveContent = {
      ...okVerifyResult,
      checks: [
        ...okVerifyResult.checks,
        { id: "active-content-headers", ok: false, required: false, hint: "nope" },
      ],
    };

    it("PUT stamps a new standby lane's activeContentVerifiedAt when the check passed", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResultWithActiveContent);
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
      const body = (await res.json()) as {
        lanes: Array<{ activeContentVerifiedAt?: string }>;
      };
      expect(body.lanes[0]?.activeContentVerifiedAt).toBeTruthy();
      const savedLane = registry.record<{
        storageLanes?: Array<{ activeContentVerifiedAt?: string }>;
      }>("acme")?.storageLanes?.[0];
      expect(savedLane?.activeContentVerifiedAt).toBeTruthy();
    });

    it("PUT leaves a new standby lane's activeContentVerifiedAt unset when the check is absent", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...SHARED_RECORD, byoBucketEnabled: true },
        usage: { objects: 0 },
      });
      setStorageVerifyForTests(async () => okVerifyResult);
      await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(CANDIDATE_BODY),
        },
        env,
      );
      const savedLane = registry.record<{
        storageLanes?: Array<{ activeContentVerifiedAt?: string }>;
      }>("acme")?.storageLanes?.[0];
      expect(savedLane?.activeContentVerifiedAt).toBeUndefined();
    });

    it("PUT rotating the active BYO lane stamps storageActiveContentVerifiedAt when the check passed", async () => {
      const { env, registry } = makeEnv({ role: "owner", record: BYO_RECORD });
      setStorageVerifyForTests(async () => okVerifyResultWithActiveContent);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeTruthy();
    });

    it("PUT rotating the active BYO lane clears a stale storageActiveContentVerifiedAt when the fresh check fails", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...BYO_RECORD, storageActiveContentVerifiedAt: "2026-01-01T00:00:00.000Z" },
      });
      setStorageVerifyForTests(async () => okVerifyResultWithFailedActiveContent);
      const res = await app.request(
        "/v1/workspaces/acme/storage",
        {
          method: "PUT",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ ...CANDIDATE_BODY, accessKeyId: "AKIDROTATED0000" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeUndefined();
    });

    it("activate carries the target lane's own activeContentVerifiedAt when the fresh-verifiedAt lane skips re-verify", async () => {
      const record = {
        ...SHARED_RECORD,
        byoBucketEnabled: true,
        storageLanes: [await standbyLane({ activeContentVerifiedAt: "2026-08-15T00:00:00.000Z" })],
      };
      const { env, registry } = makeEnv({ role: "owner", record, activeContentFlag: true });
      setStorageVerifyForTests(async () => okVerifyResult);
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { activeContentVerifiedAt?: string };
      expect(body.activeContentVerifiedAt).toBe("2026-08-15T00:00:00.000Z");
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBe("2026-08-15T00:00:00.000Z");
    });

    it("activate derives a fresh activeContentVerifiedAt from the re-verify result for a stale lane", async () => {
      const staleLane = await standbyLane({ verifiedAt: "2020-01-01T00:00:00.000Z" });
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [staleLane] };
      const { env, registry } = makeEnv({ role: "owner", record, activeContentFlag: true });
      setStorageVerifyForTests(async () => okVerifyResultWithActiveContent);
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { activeContentVerifiedAt?: string };
      expect(body.activeContentVerifiedAt).toBeTruthy();
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeTruthy();
    });

    it("activate clears activeContentVerifiedAt when a stale lane re-verifies but the active-content check fails", async () => {
      const staleLane = await standbyLane({
        verifiedAt: "2020-01-01T00:00:00.000Z",
        activeContentVerifiedAt: "2026-01-01T00:00:00.000Z",
      });
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [staleLane] };
      const { env, registry } = makeEnv({ role: "owner", record });
      setStorageVerifyForTests(async () => okVerifyResultWithFailedActiveContent);
      const res = await app.request(
        "/v1/workspaces/acme/storage/activate",
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ laneId: "lane_standby1" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { activeContentVerifiedAt?: string };
      expect(body.activeContentVerifiedAt).toBeUndefined();
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeUndefined();
    });
  });

  describe("DELETE /v1/workspaces/:workspace/storage with laneId", () => {
    it("always removes a standby lane, no emptiness check", async () => {
      const standby = {
        id: "lane_standby1",
        provider: "r2",
        bucket: "customer-bucket",
        accountId: "a".repeat(32),
        accessKeyId: "enc:v1:sealed",
        secretAccessKey: "enc:v1:sealed",
      };
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [standby] };
      const { env, registry } = makeEnv({ role: "owner", record });
      const res = await app.request(
        "/v1/workspaces/acme/storage?laneId=lane_standby1",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(0);
    });

    it("409s removing a fallback lane that still has objects, force removes it anyway", async () => {
      const fallbackBucket = new FakeR2Bucket();
      await fallbackBucket.put("still-here.png", new Uint8Array([1, 2, 3]));
      const fallback = {
        id: "lane_fallback1",
        provider: "r2",
        bucket: "old-shared",
        binding: "UPLOADS_FALLBACK",
        lastActiveAt: "2026-07-01T00:00:00.000Z",
      };
      const record = { ...BYO_RECORD, storageLanes: [fallback] };
      const { env, registry } = makeEnv({ role: "owner", record });
      (env as unknown as Record<string, unknown>).UPLOADS_FALLBACK = fallbackBucket;

      const denied = await app.request(
        "/v1/workspaces/acme/storage?laneId=lane_fallback1",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(denied.status).toBe(409);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(1);

      const forced = await app.request(
        "/v1/workspaces/acme/storage?laneId=lane_fallback1&force=true",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(forced.status).toBe(200);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(0);
    });

    it("removes an empty fallback lane without needing force", async () => {
      const emptyBucket = new FakeR2Bucket();
      const fallback = {
        id: "lane_fallback2",
        provider: "r2",
        bucket: "old-shared",
        binding: "UPLOADS_FALLBACK",
        lastActiveAt: "2026-07-01T00:00:00.000Z",
      };
      const record = { ...BYO_RECORD, storageLanes: [fallback] };
      const { env, registry } = makeEnv({ role: "owner", record });
      (env as unknown as Record<string, unknown>).UPLOADS_FALLBACK = emptyBucket;

      const res = await app.request(
        "/v1/workspaces/acme/storage?laneId=lane_fallback2",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(200);
      expect(registry.record<{ storageLanes?: unknown[] }>("acme")?.storageLanes).toHaveLength(0);
    });

    it("404s an unknown laneId", async () => {
      const { env } = makeEnv({ role: "owner", record: BYO_RECORD });
      const res = await app.request(
        "/v1/workspaces/acme/storage?laneId=lane_nonexistent",
        { method: "DELETE", headers: sessionHeaders },
        env,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/workspaces/:workspace/storage/lanes/:laneId/verify-active-content (issue #929)", () => {
    const okCheck = { id: "active-content-headers", ok: true, required: false };
    const failedCheck = {
      id: "active-content-headers",
      ok: false,
      required: false,
      hint: "missing x-content-type-options: nosniff",
    };
    const inconclusiveCheck = {
      id: "active-content-headers",
      ok: false,
      required: false,
      inconclusive: true,
      hint: "we couldn't fetch the SVG probe from here",
    };

    function verifyActiveContent(laneId: string, env: Env) {
      return app.request(
        `/v1/workspaces/acme/storage/lanes/${laneId}/verify-active-content`,
        { method: "POST", headers: sessionHeaders },
        env,
      );
    }

    // Item 4 (issue #929 final-review): same 403 `byo_bucket_disabled` gate
    // every sibling storage route enforces (`storageVerifyHandler`,
    // `storagePutHandler`, ...) — this route was missing it, so a workspace
    // with BYO storage turned off could still trigger a real probe against
    // its own lane's credentials.
    it("403s (byo_bucket_disabled) when the workspace flag is explicitly off", async () => {
      const { env } = makeEnv({
        role: "owner",
        record: { ...BYO_RECORD, byoBucketEnabled: false },
      });
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "byo_bucket_disabled",
      );
    });

    it("stamps storageActiveContentVerifiedAt on the active lane (named by the literal 'active') when the probe passes", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: BYO_RECORD,
        activeContentFlag: true,
      });
      let seenLane: { publicBaseUrl?: string } | undefined;
      setLaneActiveContentCheckForTests(async (_env, lane) => {
        seenLane = lane;
        return okCheck;
      });
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        check: typeof okCheck;
        status: { activeContentVerifiedAt?: string };
      };
      expect(body.check).toEqual(okCheck);
      expect(body.status.activeContentVerifiedAt).toBeTruthy();
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeTruthy();
      // The active lane's own fields (publicBaseUrl, in particular) reached
      // the check — proof `resolveActiveContentLaneTarget` built the right
      // lane view, not an empty one.
      expect(seenLane?.publicBaseUrl).toBe(BYO_RECORD.publicBaseUrl);
    });

    // The response's `status` is the live gate projection (issue #929
    // review), not an echo of the stamp this route just wrote — a
    // workspace-level opt-out still closes the gate even though the probe
    // itself passed and the stamp was written.
    it("reports opted_out on the status even when the probe passes, for a workspace that opted out", async () => {
      const { env, registry } = makeEnv({
        role: "owner",
        record: { ...BYO_RECORD, activeContentUploads: false },
        activeContentFlag: true,
      });
      setLaneActiveContentCheckForTests(async () => okCheck);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        check: typeof okCheck;
        status: { activeContentVerifiedAt?: string; activeContentReason?: string };
      };
      expect(body.check).toEqual(okCheck);
      expect(body.status.activeContentVerifiedAt).toBeUndefined();
      expect(body.status.activeContentReason).toBe("opted_out");
      // The probe still wrote its own stamp — only the live gate's
      // projection is suppressed by the opt-out, not the underlying write.
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeTruthy();
    });

    it("also resolves the active lane by its own storageLaneId, not just the literal 'active'", async () => {
      const record = { ...BYO_RECORD, storageLaneId: "lane_active1" };
      const { env, registry } = makeEnv({ role: "owner", record });
      setLaneActiveContentCheckForTests(async () => okCheck);
      const res = await verifyActiveContent("lane_active1", env);
      expect(res.status).toBe(200);
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeTruthy();
    });

    it("clears a previously-fresh stamp on the active lane when the probe fails", async () => {
      const record = { ...BYO_RECORD, storageActiveContentVerifiedAt: "2020-01-01T00:00:00.000Z" };
      const { env, registry } = makeEnv({ role: "owner", record });
      setLaneActiveContentCheckForTests(async () => failedCheck);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { check: typeof failedCheck };
      expect(body.check).toEqual(failedCheck);
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeUndefined();
    });

    it("leaves the stamp unchanged, with no KV write, when the probe is inconclusive", async () => {
      const record = { ...BYO_RECORD, storageActiveContentVerifiedAt: "2020-01-01T00:00:00.000Z" };
      const { env, registry } = makeEnv({ role: "owner", record });
      const putsBefore = registry.puts.length;
      setLaneActiveContentCheckForTests(async () => inconclusiveCheck);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { check: typeof inconclusiveCheck };
      expect(body.check).toEqual(inconclusiveCheck);
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBe("2020-01-01T00:00:00.000Z");
      expect(registry.puts.length).toBe(putsBefore);
    });

    it("stamps a saved (non-active) lane's own activeContentVerifiedAt, not the top-level one", async () => {
      const lane = await standbyLane();
      const record = { ...SHARED_RECORD, byoBucketEnabled: true, storageLanes: [lane] };
      const { env, registry } = makeEnv({ role: "owner", record });
      setLaneActiveContentCheckForTests(async () => okCheck);
      const res = await verifyActiveContent("lane_standby1", env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: { lanes: Array<{ laneId: string; activeContentVerifiedAt?: string }> };
      };
      expect(body.status.lanes[0]).toMatchObject({
        laneId: "lane_standby1",
        activeContentVerifiedAt: expect.any(String),
      });
      expect(
        registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
          ?.storageActiveContentVerifiedAt,
      ).toBeUndefined();
      const savedLane = registry.record<{
        storageLanes?: Array<{ activeContentVerifiedAt?: string }>;
      }>("acme")?.storageLanes?.[0];
      expect(savedLane?.activeContentVerifiedAt).toBeTruthy();
    });

    it("422s a shared (hosted) lane instead of running the probe", async () => {
      const { env } = makeEnv({ role: "owner", record: SHARED_RECORD });
      const check = vi.fn();
      setLaneActiveContentCheckForTests(check);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { check: { ok: boolean } };
      expect(body.check.ok).toBe(false);
      expect(check).not.toHaveBeenCalled();
    });

    it("422s a lane with no publicBaseUrl to verify", async () => {
      const { publicBaseUrl: _unused, ...noUrlRecord } = BYO_RECORD;
      const { env } = makeEnv({ role: "owner", record: noUrlRecord });
      const check = vi.fn();
      setLaneActiveContentCheckForTests(check);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(422);
      expect(check).not.toHaveBeenCalled();
    });

    it("404s an unknown laneId", async () => {
      const { env } = makeEnv({ role: "owner", record: BYO_RECORD });
      const res = await verifyActiveContent("lane_nonexistent", env);
      expect(res.status).toBe(404);
    });

    it("429s when the write rate limit is exceeded", async () => {
      const { env } = makeEnv({ role: "owner", record: BYO_RECORD, writeLimiterOk: false });
      setLaneActiveContentCheckForTests(async () => okCheck);
      const res = await verifyActiveContent("active", env);
      expect(res.status).toBe(429);
    });
  });
});

describe("/me alias forwards (issue #613 phase 3)", () => {
  afterEach(() => {
    setLaneActiveContentCheckForTests(undefined);
  });

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

  // A Better Auth bearer session (device-flow token, no cookie) authenticates
  // at /me; the forwarded request keeps its Authorization header, so the
  // settings gates must honor the pre-resolved-session handoff instead of
  // rejecting the bearer header (the #617 review's ordering lesson).
  it("GET /me/workspaces/:name/summary works via a Better Auth bearer session", async () => {
    const { env } = makeEnv({ sessionUser: MEMBER, role: "member", usage: { objects: 0 } });
    const res = await app.request(
      "/me/workspaces/acme/summary",
      { headers: { Authorization: "Bearer ba-session-token" } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("GET /me/workspaces/:name/comment-settings works via a Better Auth bearer session", async () => {
    const { env } = makeEnv({ role: "admin" });
    const res = await app.request(
      "/me/workspaces/acme/comment-settings",
      { headers: { Authorization: "Bearer ba-session-token" } },
      env,
    );
    expect(res.status).toBe(200);
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

  // The verify-active-content stamp is time-dependent (`new Date().toISOString()`
  // at write time), so this checks the alias runs the same handler and has
  // the same effect rather than diffing two live-timestamped bodies.
  it("POST /me/workspaces/:name/storage/lanes/:laneId/verify-active-content forwards to the canonical route", async () => {
    const BYO_RECORD = {
      provider: "r2",
      bucket: "customer-bucket",
      accountId: "a".repeat(32),
      accessKeyId: "enc:v1:sealed-key-id",
      secretAccessKey: "enc:v1:already-sealed",
      publicBaseUrl: "https://media.example.com",
      byoBucketEnabled: true,
      storageAccessKeyIdLast4: "1234",
    };
    const { env, registry } = makeEnv({
      role: "owner",
      record: BYO_RECORD,
      activeContentFlag: true,
    });
    setLaneActiveContentCheckForTests(async () => ({
      id: "active-content-headers",
      ok: true,
      required: false,
    }));
    const res = await app.request(
      "/me/workspaces/acme/storage/lanes/active/verify-active-content",
      { method: "POST", headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      check: { ok: boolean };
      status: { activeContentVerifiedAt?: string };
    };
    expect(body.check.ok).toBe(true);
    expect(body.status.activeContentVerifiedAt).toBeTruthy();
    expect(
      registry.record<{ storageActiveContentVerifiedAt?: string }>("acme")
        ?.storageActiveContentVerifiedAt,
    ).toBeTruthy();
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

describe("GET /v1/workspaces/:workspace/comment-preview (issue #613 final phase)", () => {
  function makePreviewEnv(opts: EnvOpts = {}) {
    const { registry, db, env, bucket } = (() => {
      const bucket = new FakeR2Bucket();
      const record = {
        ...SHARED_RECORD,
        binding: "UPLOADS_DEFAULT",
        publicBaseUrl: "https://cdn.uploads.test",
      };
      const base = makeEnv({ ...opts, record });
      return {
        ...base,
        bucket,
        env: {
          ...base.env,
          UPLOADS_DEFAULT: bucket,
          WEB_ORIGIN: "https://uploads.test",
        } as unknown as Env,
      };
    })();
    return { env, registry, db, bucket };
  }

  it("200s for an admin session with the fixture fallback when the workspace has no gh/ uploads", async () => {
    const { env } = makePreviewEnv({ role: "admin" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sample: string; body: string };
    expect(body.sample).toBe("fixtures");
    expect(typeof body.body).toBe("string");
  });

  it("renders workspace attachments with their D1 path/state metadata (before/after pairing)", async () => {
    const { env, db, bucket } = makePreviewEnv({ role: "admin" });
    // Filenames deliberately carry no before/after stem token, so a paired
    // render can only come from the D1 path/state metadata rows below.
    await bucket.put("acme/gh/acme-web/pull-1/one.png", "a", {
      httpMetadata: { contentType: "image/png" },
    });
    await bucket.put("acme/gh/acme-web/pull-1/two.png", "b", {
      httpMetadata: { contentType: "image/png" },
    });
    db.fileMetadata.set(
      "acme gh/acme-web/pull-1/one.png",
      new Map([
        ["path", "docs/hero.png"],
        ["state", "before"],
      ]),
    );
    db.fileMetadata.set(
      "acme gh/acme-web/pull-1/two.png",
      new Map([
        ["path", "docs/hero.png"],
        ["state", "after"],
      ]),
    );

    const res = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sample: string; body: string };
    expect(body.sample).toBe("workspace");
    expect(body.body).toContain("<strong>Before</strong>");
    expect(body.body).toContain("<strong>After</strong>");
    expect(body.body).toContain("docs/hero.png");
  });

  it("403s a non-admin member session", async () => {
    const { env } = makePreviewEnv({ sessionUser: MEMBER, role: "member" });
    const res = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_admin_required",
    );
  });

  it("404s a non-member session", async () => {
    const { env } = makePreviewEnv({ noMembership: true });
    const res = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("403s a bearer token with settings_requires_session", async () => {
    const { env } = makePreviewEnv();
    const res = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: bearerHeaders },
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "settings_requires_session",
    );
  });

  it("/me/workspaces/:name/comment-preview forwards to the same handler (identical body)", async () => {
    const { env } = makePreviewEnv({ role: "admin" });
    const canonical = await app.request(
      "/v1/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    const alias = await app.request(
      "/me/workspaces/acme/comment-preview",
      { headers: sessionHeaders },
      env,
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });
});
