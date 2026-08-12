/**
 * Route coverage for `POST /v1/:workspace/github/private-prefix/rotate`
 * (issue #631, Task 8) — exercised through the real composed `app`
 * (index.ts), same style as `routes-github-private-prefix.test.ts`. The
 * move/rename/resync mechanics live in `github-private-prefix-rotate.test.ts`;
 * this file is scoped to the HTTP wrapper: auth, body validation, the
 * unauthorized-decline-is-an-error posture (403, not a fail-open 200), and
 * the `{ rotated: false }` response shape.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { recordRepoLink } from "../src/github-repo-links";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { UsageFakeD1 } from "./usage-fake-d1";

const WS = "acme";
const REPO = "acme/web";
const TOKEN = "private-prefix-rotate-token";

// Same polyfill as routes-github-private-prefix.test.ts.
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

async function makeEnv(): Promise<{
  env: Parameters<typeof app.request>[2];
  db: UsageFakeD1;
  githubCache: FakeKv;
}> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(TOKEN), createdAt: new Date().toISOString() }],
  };
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    GITHUB_CACHE: githubCache,
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    ...GITHUB_APP_CFG_ENV,
  };
  return { env: env as unknown as Parameters<typeof app.request>[2], db, githubCache };
}

function bearer(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function post(path: string, body: unknown, env: Parameters<typeof app.request>[2], headers = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/:workspace/github/private-prefix/rotate", () => {
  it("no active id for the branch: 200 { rotated: false, reason: 'no_prefix' }", async () => {
    const { env, db } = await makeEnv();
    await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");

    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: REPO, branch: "main" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rotated: false, reason: "no_prefix" });
  });

  it("repoLevel: true also resolves the no-prefix shape", async () => {
    const { env, db } = await makeEnv();
    await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");

    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: REPO, repoLevel: true },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rotated: false, reason: "no_prefix" });
  });

  it("repo bound to a different workspace: 403, not a fail-open 200", async () => {
    const { env, db } = await makeEnv();
    await recordRepoLink(db as unknown as D1Database, REPO, "someone-else", "test");

    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: REPO, branch: "main" },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });

  it("no bearer token: 401", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/acme/github/private-prefix/rotate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO, branch: "main" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("malformed body (bad repo grammar): 4xx AppError envelope", async () => {
    const { env } = await makeEnv();
    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: "not-a-repo", branch: "main" },
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });

  it("both branch and repoLevel: 4xx AppError envelope", async () => {
    const { env } = await makeEnv();
    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: REPO, branch: "main", repoLevel: true },
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });

  it("neither branch nor repoLevel: 4xx AppError envelope", async () => {
    const { env } = await makeEnv();
    const res = await post("/v1/acme/github/private-prefix/rotate", { repo: REPO }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });

  it("empty-string branch: 4xx AppError envelope (repoLevel is the only sentinel path)", async () => {
    const { env } = await makeEnv();
    const res = await post(
      "/v1/acme/github/private-prefix/rotate",
      { repo: REPO, branch: "" },
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });
});
