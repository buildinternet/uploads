import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { UsageFakeD1 } from "../../test/usage-fake-d1";

// Same node-vs-workerd Web Crypto gap as github-promote-route.test.ts — this
// suite exercises the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";
const REPO = "acme/web";

interface Seeded {
  env: Env;
  db: UsageFakeD1;
}

async function seededEnv(workspace = WS, token = TOKEN): Promise<Seeded> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: `${workspace}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(token), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${workspace}` ? record : null) as unknown as KVNamespace["get"],
  };
  const db = new UsageFakeD1();
  const env = { REGISTRY: registry, DB: db } as unknown as Env;
  return { env, db };
}

function get(env: Env, workspace: string, repo: string, token: string) {
  return app.request(
    `/v1/${workspace}/github/link?repo=${encodeURIComponent(repo)}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
    env,
  );
}

function post(env: Env, workspace: string, body: unknown, token: string) {
  return app.request(
    `/v1/${workspace}/github/link`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("GET /v1/:workspace/github/link", () => {
  it("reports no binding when the repo is unclaimed", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, linked: false, workspace: null });
  });

  it("reports the binding when the repo is claimed", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: WS,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await get(env, WS, REPO, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: REPO, linked: true, workspace: WS });
  });

  it("400s on a malformed repo", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, "not-a-repo", TOKEN);
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(`/v1/${WS}/github/link?repo=${REPO}`, {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/:workspace/github/link", () => {
  it("claims an unbound repo", async () => {
    const { env, db } = await seededEnv();
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: true, workspace: WS, source: "cli" });
    expect(db.repoLinks.get(REPO)).toMatchObject({ workspace_name: WS, source: "cli" });
  });

  it("honestly reports an already-bound-by-another-workspace repo (claimed: false)", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: "someone-else",
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      claimed: false,
      linked: true,
      workspace: "someone-else",
    });
    // First-claim-wins: never overwritten.
    expect(db.repoLinks.get(REPO)?.workspace_name).toBe("someone-else");
  });

  it("is idempotent for the owning workspace (claimed: true, no duplicate row)", async () => {
    const { env, db } = await seededEnv();
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: WS,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(env, WS, { repo: REPO }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: true, workspace: WS, source: "comment" });
  });

  it("400s on a malformed repo", async () => {
    const { env } = await seededEnv();
    const res = await post(env, WS, { repo: "../etc" }, TOKEN);
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(
      `/v1/${WS}/github/link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
