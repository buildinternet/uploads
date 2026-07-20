import { describe, expect, it } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeKv } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";

// `crypto.subtle.timingSafeEqual` is a Workers-runtime extension to Web
// Crypto (used by workspaceAuth, see ../workspace.ts) that plain Node's
// `crypto` doesn't implement, and this repo has no vitest workerd pool
// configured. Polyfill a (non-constant-time, test-only) equivalent so this
// file can exercise the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";

async function seededEnv(opts: { installNone?: boolean } = {}): Promise<Env> {
  const hash = await sha256Hex(TOKEN);
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    tokens: [{ hash, createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  const githubCache = new FakeKv();
  if (opts.installNone) githubCache.store.set("ghinst:acme/web", { value: "none" });
  return {
    REGISTRY: registry,
    DB: new UsageFakeD1(),
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
}

function post(env: Env, body: unknown) {
  return app.request(
    `/v1/${WS}/github/comment`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/:workspace/github/comment", () => {
  it("returns not_installed when the App has no installation for the repo", async () => {
    const env = await seededEnv({ installNone: true });
    const res = await post(env, { repo: "acme/web", num: 12, kind: "pull" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: false, reason: "not_installed" });
  });

  it("400s on a malformed body", async () => {
    const env = await seededEnv();
    const res = await post(env, { repo: "not-a-repo", num: 0, kind: "nope" });
    expect(res.status).toBe(400);
  });
});
