/**
 * Issue #613 phase 4: canonical dual-auth coverage for the four legacy file
 * operations whose handler bodies are now shared by both routers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { withMintingUserToken } from "./helpers/fake-minting-user-token";
import { UsageFakeD1 } from "./usage-fake-d1";

const WS = "acme";
const LEGACY_TOKEN = "canonical-core-legacy-token";
const SCOPED_TOKEN = "canonical-core-scoped-token";
const USER = { id: "u-1", email: "member@example.com", name: "Member" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const KEY = "shots/a.png";

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

type Operation = "sign" | "put" | "get" | "patch";

interface EnvOptions {
  member?: boolean;
  scopedTokenScopes?: string[];
  writeLimiterOk?: boolean;
}

function addRouteTestQueries(db: UsageFakeD1): void {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT p.meta_value AS path")) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { success: true, results: [] as T[], meta: {} };
        },
      };
    }
    if (normalized.startsWith("INSERT INTO daily_metrics")) {
      return {
        bind() {
          return this;
        },
        async run() {
          return { success: true, results: [], meta: { changes: 1 } };
        },
      };
    }
    return originalPrepare(sql);
  }) as UsageFakeD1["prepare"];
}

async function makeEnv(opts: EnvOptions = {}) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: `${WS}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(LEGACY_TOKEN),
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  addRouteTestQueries(db);
  if (opts.scopedTokenScopes) {
    withMintingUserToken(db, {
      workspace: WS,
      tokenHash: await sha256Hex(SCOPED_TOKEN),
      mintingUserId: USER.id,
      scopes: opts.scopedTokenScopes,
    });
  }

  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    UPLOADS_DEFAULT: bucket,
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: opts.writeLimiterOk ?? true }) },
    WEB_ORIGIN: "https://uploads.sh",
    GITHUB_CACHE: { get: async () => null, put: async () => undefined },
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          return Response.json({ session: {}, user: USER });
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            opts.member === false
              ? []
              : [
                  {
                    organizationId: "org-1",
                    organizationSlug: WS,
                    organizationName: "Acme",
                    role: "member",
                  },
                ],
          );
        }
        return Response.json({ githubAccountId: null });
      },
    },
  };
  return { env: env as unknown as Parameters<typeof app.request>[2], bucket, db };
}

async function seed(bucket: FakeR2Bucket, key = KEY): Promise<void> {
  await bucket.put(`${WS}/${key}`, PNG, { httpMetadata: { contentType: "image/png" } });
  bucket.setUploaded(`${WS}/${key}`, new Date("2026-08-11T12:00:00.000Z"));
}

function authHeaders(kind: "legacy" | "scoped" | "session"): Record<string, string> {
  if (kind === "session") return { cookie: "session=x" };
  return { Authorization: `Bearer ${kind === "legacy" ? LEGACY_TOKEN : SCOPED_TOKEN}` };
}

function operationRequest(
  operation: Operation,
  canonical: boolean,
  auth: "legacy" | "scoped" | "session",
): { path: string; init: RequestInit } {
  const base = canonical ? `/v1/workspaces/${WS}/files` : `/v1/${WS}/files`;
  const headers = authHeaders(auth);
  if (operation === "sign") {
    return {
      path: `${base}/sign`,
      init: {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ key: KEY, contentType: "image/png" }),
      },
    };
  }
  if (operation === "put") {
    return {
      path: `${base}/${KEY}`,
      init: {
        method: "PUT",
        headers: { ...headers, "content-type": "image/png" },
        body: PNG,
      },
    };
  }
  if (operation === "patch") {
    return {
      path: `${base}/${KEY}`,
      init: {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ set: { app: "web" } }),
      },
    };
  }
  return { path: `${base}/${KEY}`, init: { headers } };
}

async function requestOperation(
  operation: Operation,
  canonical: boolean,
  auth: "legacy" | "scoped" | "session",
  env: Parameters<typeof app.request>[2],
): Promise<Response> {
  const { path, init } = operationRequest(operation, canonical, auth);
  return app.request(path, init, env);
}

async function prepareOperation(operation: Operation, bucket: FakeR2Bucket): Promise<void> {
  if (operation === "get" || operation === "patch") await seed(bucket);
}

function expectHandlerResult(operation: Operation, status: number, body: unknown): void {
  if (operation === "sign") {
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "presign_unavailable" } });
  } else if (operation === "put") {
    expect(status).toBe(201);
    expect(body).toMatchObject({ workspace: WS, key: KEY, contentType: "image/png" });
  } else if (operation === "get") {
    expect(status).toBe(200);
    expect(body).toMatchObject({ key: KEY, contentType: "image/png" });
  } else {
    expect(status).toBe(200);
    expect(body).toEqual({ metadata: { app: "web" } });
  }
}

const OPERATION_SCOPES: Array<{
  operation: Operation;
  required: "files:read" | "files:write";
  insufficient: "files:read" | "files:write";
}> = [
  { operation: "sign", required: "files:write", insufficient: "files:read" },
  { operation: "put", required: "files:write", insufficient: "files:read" },
  { operation: "get", required: "files:read", insufficient: "files:write" },
  { operation: "patch", required: "files:write", insufficient: "files:read" },
];

describe.each(OPERATION_SCOPES)(
  "$operation /v1/workspaces/:workspace/files canonical core operation",
  ({ operation, required, insufficient }) => {
    it(`accepts a bearer token with ${required}`, async () => {
      const { env, bucket, db } = await makeEnv({ scopedTokenScopes: [required] });
      await prepareOperation(operation, bucket);
      const res = await requestOperation(operation, true, "scoped", env);
      expectHandlerResult(operation, res.status, await res.json());
      if (operation === "put") {
        expect(bucket.store.has(`${WS}/${KEY}`)).toBe(true);
        expect(db.usage.get(WS)).toMatchObject({ bytes: PNG.byteLength, objects: 1 });
      }
    });

    it(`403s a bearer token with only ${insufficient}`, async () => {
      const { env, bucket } = await makeEnv({ scopedTokenScopes: [insufficient] });
      await prepareOperation(operation, bucket);
      const res = await requestOperation(operation, true, "scoped", env);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { type: "insufficient_scope", details: { required_scope: required } },
      });
      if (operation === "put") expect(bucket.store.has(`${WS}/${KEY}`)).toBe(false);
    });

    it("accepts a member session and reaches the same handler", async () => {
      const { env, bucket } = await makeEnv();
      await prepareOperation(operation, bucket);
      const res = await requestOperation(operation, true, "session", env);
      expectHandlerResult(operation, res.status, await res.json());
    });

    it("404s a non-member session before handler mutation", async () => {
      const { env, bucket } = await makeEnv({ member: false });
      await prepareOperation(operation, bucket);
      const before = bucket.store.get(`${WS}/${KEY}`);
      const res = await requestOperation(operation, true, "session", env);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "workspace_not_found" } });
      expect(bucket.store.get(`${WS}/${KEY}`)).toEqual(before);
    });

    it("matches the legacy bearer path status and JSON body", async () => {
      const legacy = await makeEnv();
      const canonical = await makeEnv();
      await prepareOperation(operation, legacy.bucket);
      await prepareOperation(operation, canonical.bucket);
      const legacyRes = await requestOperation(operation, false, "legacy", legacy.env);
      const canonicalRes = await requestOperation(operation, true, "legacy", canonical.env);
      expect(canonicalRes.status).toBe(legacyRes.status);
      expect(await canonicalRes.json()).toEqual(await legacyRes.json());
    });
  },
);

describe("canonical file catch-all route ordering", () => {
  it("keeps files/search on the static search handler", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket, "search");
    const res = await app.request(
      `/v1/workspaces/${WS}/files/search`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "file_metadata_invalid_key" } });
  });

  it("keeps files/facets on the static facets handler", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket, "facets");
    const res = await app.request(
      `/v1/workspaces/${WS}/files/facets`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [], truncated: false });
  });

  it("keeps files/by-path on the static grouping handler", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket, "by-path");
    const res = await app.request(
      `/v1/workspaces/${WS}/files/by-path`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: [], projects: [], truncated: false });
  });

  it("keeps files/file-url on the static URL handler", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket, "file-url");
    const res = await app.request(
      `/v1/workspaces/${WS}/files/file-url`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { type: "not_found" } });
  });

  it("matches legacy reserved-key shadowing and still reaches nested ordinary keys", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket, "facets");
    await seed(bucket, "shots/search");

    const legacyReserved = await app.request(
      `/v1/${WS}/files/facets`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(legacyReserved.status).toBe(200);
    expect(await legacyReserved.json()).toEqual({ keys: [], truncated: false });

    const nested = await app.request(
      `/v1/workspaces/${WS}/files/shots/search`,
      { headers: authHeaders("legacy") },
      env,
    );
    expect(nested.status).toBe(200);
    expect(await nested.json()).toMatchObject({ key: "shots/search" });
  });
});
