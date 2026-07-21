import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";
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

/** Generate a throwaway RSA key and return its PKCS#8 PEM (github-app.test.ts's helper). */
async function testKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

async function seededEnv(extraEnv: Record<string, unknown> = {}) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: `${WS}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(TOKEN), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  return { REGISTRY: registry, DB: new UsageFakeD1(), ...extraEnv } as unknown as Env;
}

function getHealth(env: Env) {
  return app.request(
    `/v1/${WS}/github/health`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
    env,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/:workspace/github/health", () => {
  it("reports not configured when GitHub App env is unset", async () => {
    const env = await seededEnv();
    const res = await getHealth(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: false,
      ok: false,
      recommendedEvents: ["issue_comment"],
      missingRecommendedEvents: ["issue_comment"],
    });
  });

  it("reports ok when subscribed to all required events", async () => {
    const pem = await testKeyPem();
    const env = await seededEnv({ ...GITHUB_APP_CFG_ENV, GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ events: ["ping", "issues", "pull_request"] }), {
            status: 200,
          }),
      ),
    );
    const res = await getHealth(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      ok: true,
      missingEvents: [],
      requiredEvents: ["issues", "pull_request"],
      recommendedEvents: ["issue_comment"],
      missingRecommendedEvents: ["issue_comment"],
    });
  });

  it("reports ok=true and no missing recommended events when subscribed to issue_comment too", async () => {
    const pem = await testKeyPem();
    const env = await seededEnv({ ...GITHUB_APP_CFG_ENV, GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ events: ["ping", "issues", "pull_request", "issue_comment"] }),
            { status: 200 },
          ),
      ),
    );
    const res = await getHealth(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      missingEvents: [],
      missingRecommendedEvents: [],
    });
  });

  it("reports missing events when the App isn't subscribed", async () => {
    const pem = await testKeyPem();
    const env = await seededEnv({ ...GITHUB_APP_CFG_ENV, GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ events: ["ping"] }), { status: 200 })),
    );
    const res = await getHealth(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; missingEvents: string[]; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.missingEvents).toEqual(["issues", "pull_request"]);
    expect(body.hint).toContain("issues, pull_request");
  });

  it("stays ok=false based only on required events even when recommended events are also missing", async () => {
    const pem = await testKeyPem();
    const env = await seededEnv({ ...GITHUB_APP_CFG_ENV, GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ events: ["ping"] }), { status: 200 })),
    );
    const res = await getHealth(env);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, missingRecommendedEvents: ["issue_comment"] });
  });

  it("reports the check as failed when GET /app fails", async () => {
    const pem = await testKeyPem();
    const env = await seededEnv({ ...GITHUB_APP_CFG_ENV, GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const res = await getHealth(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      ok: false,
      events: null,
      recommendedEvents: ["issue_comment"],
      missingRecommendedEvents: ["issue_comment"],
    });
  });

  it("401s with no bearer token", async () => {
    const env = await seededEnv();
    const res = await app.request(`/v1/${WS}/github/health`, {}, env);
    expect(res.status).toBe(401);
  });
});
