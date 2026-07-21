import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { UsageFakeD1 } from "../../test/usage-fake-d1";

// Same node-vs-workerd Web Crypto gap as github-link-route.test.ts — this
// suite exercises the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";

async function seededEnv(workspace = WS, token = TOKEN): Promise<{ env: Env; db: UsageFakeD1 }> {
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

function get(env: Env, workspace: string, token: string, query = "") {
  return app.request(
    `/v1/${workspace}/github/activity${query}`,
    { headers: { authorization: `Bearer ${token}` } },
    env,
  );
}

function seedActivity(db: UsageFakeD1, prNumber: number, lastMediaAt: string, workspace = WS) {
  db.prActivity.set(`acme/web#${prNumber}`, {
    ref: `acme/web#${prNumber}`,
    repo_full_name: "acme/web",
    pr_number: prNumber,
    branch: "feat/x",
    workspace_name: workspace,
    media_count: 3,
    first_media_at: "2026-07-20T09:00:00.000Z",
    last_media_at: lastMediaAt,
  });
}

describe("GET /v1/:workspace/github/activity", () => {
  it("requires auth", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns an empty feed when the workspace has no PR media activity", async () => {
    const { env } = await seededEnv();
    const res = await get(env, WS, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: WS, activity: [] });
  });

  it("lists the workspace's PRs, most recent media first", async () => {
    const { env, db } = await seededEnv();
    seedActivity(db, 1, "2026-07-21T10:00:00.000Z");
    seedActivity(db, 2, "2026-07-21T12:00:00.000Z");
    seedActivity(db, 99, "2026-07-21T13:00:00.000Z", "someone-else");
    const res = await get(env, WS, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { prNumber: number; mediaCount: number }[] };
    expect(body.activity.map((a) => a.prNumber)).toEqual([2, 1]);
    expect(body.activity[0]).toMatchObject({
      ref: "acme/web#2",
      repo: "acme/web",
      branch: "feat/x",
      mediaCount: 3,
      lastMediaAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("honors limit and rejects a malformed one", async () => {
    const { env, db } = await seededEnv();
    seedActivity(db, 1, "2026-07-21T10:00:00.000Z");
    seedActivity(db, 2, "2026-07-21T12:00:00.000Z");
    const ok = await get(env, WS, TOKEN, "?limit=1");
    const body = (await ok.json()) as { activity: unknown[] };
    expect(body.activity).toHaveLength(1);
    for (const bad of ["0", "101", "abc", "1.5"]) {
      const res = await get(env, WS, TOKEN, `?limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });
});
