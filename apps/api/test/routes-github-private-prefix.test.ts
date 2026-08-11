/**
 * Route coverage for `POST /v1/:workspace/github/private-prefix` (issue
 * #631, Task 4) — exercised through the real composed `app` (index.ts),
 * same style as `routes-workspace-github.test.ts`. The decision-flow matrix
 * (plain vs. private, branch/target resolution, unauthorized no-oracle,
 * privacy-lookup failure) lives in `github-private-prefix-service.test.ts`;
 * this file is scoped to the HTTP wrapper: auth, body validation, and
 * response shapes.
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
const TOKEN = "private-prefix-token";

// Same polyfill as routes-workspace-github.test.ts — the workspace bearer
// auth path needs `crypto.subtle.timingSafeEqual`, which isn't implemented
// in every vitest environment's WebCrypto.
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

describe("POST /v1/:workspace/github/private-prefix", () => {
  it("no App config: 200 { mode: 'plain' }", async () => {
    const { env } = await makeEnv();
    const res = await post("/v1/acme/github/private-prefix", { repo: REPO, branch: "main" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "plain" });
  });

  it("private + authorized: 200 { mode: 'private', prefixId, activePrefixIds }", async () => {
    const { env, db, githubCache } = await makeEnv();
    githubCache.store.set(`ghinst:${REPO}`, { value: "42" });
    githubCache.store.set(`ghpriv:${REPO}`, { value: "1" });
    await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");

    const res = await post("/v1/acme/github/private-prefix", { repo: REPO, branch: "feat-x" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      prefixId: string;
      activePrefixIds: string[];
    };
    expect(body.mode).toBe("private");
    expect(body.prefixId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.activePrefixIds).toEqual([body.prefixId]);
  });

  it("no bearer token: 401", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/acme/github/private-prefix",
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
    const res = await post("/v1/acme/github/private-prefix", { repo: "not-a-repo" }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error).toBeDefined();
  });

  it("malformed body (bad target.kind): 4xx AppError envelope", async () => {
    const { env } = await makeEnv();
    const res = await post(
      "/v1/acme/github/private-prefix",
      { repo: REPO, target: { kind: "commits", num: 1 } },
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
  });
});
