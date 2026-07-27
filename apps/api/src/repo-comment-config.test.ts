/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  fetchRepoCommentConfig,
  resolveRepoCommentOptions,
  workspaceCommentDefaults,
  REPO_CONFIG_PATHS,
  REPO_CONFIG_TTL_SECONDS,
} from "./repo-comment-config";
import type { WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";

/** Generate a throwaway RSA key and return its PKCS#8 PEM (mirrors github-app.test.ts's testKeyPair). */
async function testPem(): Promise<string> {
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

function makeEnv(kv: FakeKv, pem: string): Env {
  return {
    GITHUB_CACHE: kv,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_APP_HOME_INSTALLATION_ID: "9",
  } as unknown as Env;
}

/** Counts fetches and answers with route handlers keyed by substring match. */
function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  let calls = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls++;
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const installationRoute = () => new Response(JSON.stringify({ id: 42 }), { status: 200 });
const tokenRoute = () => new Response(JSON.stringify({ token: "ghs_test" }), { status: 201 });

describe("fetchRepoCommentConfig", () => {
  it("finds config at .uploads.yml, parses it, and caches it", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.yml": () =>
        new Response("comment:\n  imageWidth: full\n", { status: 200 }),
    });
    // Inject the fetch impl via globalThis.fetch override since the module
    // uses the ambient `fetch` unless a seam is provided.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await fetchRepoCommentConfig(env, "acme/web");
      expect(result.found).toBe(true);
      expect(result.path).toBe(".uploads.yml");
      expect(result.config?.imageWidth).toBe("full");
      expect(result.warnings).toEqual([]);

      const cached = await kv.get("repocfg:acme/web", "json");
      expect(cached).toEqual(result);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls through 404s to .uploads.json and parses as JSON", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.json": () =>
        new Response(JSON.stringify({ comment: { imageWidth: 320 } }), { status: 200 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await fetchRepoCommentConfig(env, "acme/web");
      expect(result.found).toBe(true);
      expect(result.path).toBe(".uploads.json");
      expect(result.config?.imageWidth).toBe(320);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caches a negative result when all six candidates 404, and stops fetching on the next call", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl, calls } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      // No /contents/ route registered -> every candidate 404s.
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const first = await fetchRepoCommentConfig(env, "acme/web");
      expect(first.found).toBe(false);
      expect(first.path).toBeNull();
      const callsAfterFirst = calls();
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await fetchRepoCommentConfig(env, "acme/web");
      expect(second).toEqual(first);
      expect(calls()).toBe(callsAfterFirst); // zero additional fetches
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a cached result with zero fetches on a warm cache (config found)", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl, calls } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.yml": () => new Response("comment:\n  note: hello\n", { status: 200 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const first = await fetchRepoCommentConfig(env, "acme/web");
      const callsAfterFirst = calls();
      expect(first.found).toBe(true);

      const second = await fetchRepoCommentConfig(env, "acme/web");
      expect(second).toEqual(first);
      expect(calls()).toBe(callsAfterFirst);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not cache a transient contents-API failure (500)", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl, calls } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.yml": () => new Response("boom", { status: 500 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const first = await fetchRepoCommentConfig(env, "acme/web");
      expect(first.found).toBe(false);
      const cached = await kv.get("repocfg:acme/web", "json");
      expect(cached).toBeNull();

      const callsAfterFirst = calls();
      const second = await fetchRepoCommentConfig(env, "acme/web");
      expect(second.found).toBe(false);
      expect(calls()).toBeGreaterThan(callsAfterFirst); // re-fetched, not cached
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caches a found-but-unparseable file (found:true, config:null, warning)", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl, calls } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.yml": () => new Response("not: valid: yaml: [", { status: 200 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const first = await fetchRepoCommentConfig(env, "acme/web");
      expect(first.found).toBe(true);
      expect(first.config).toBeNull();
      expect(first.warnings.length).toBeGreaterThan(0);

      const callsAfterFirst = calls();
      const second = await fetchRepoCommentConfig(env, "acme/web");
      expect(second).toEqual(first);
      expect(calls()).toBe(callsAfterFirst); // cached, no re-fetch
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades to not-found, uncached, when the App is not configured", async () => {
    const kv = new FakeKv();
    const env = { GITHUB_CACHE: kv } as unknown as Env; // no GITHUB_APP_* members
    const result = await fetchRepoCommentConfig(env, "acme/web");
    expect(result).toEqual({ found: false, path: null, config: null, warnings: [] });
    const cached = await kv.get("repocfg:acme/web", "json");
    expect(cached).toBeNull();
  });

  it("degrades to not-found, uncached, when the repo has no installation", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl } = fakeFetch({
      "/installation": () => new Response("nope", { status: 404 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await fetchRepoCommentConfig(env, "acme/web");
      expect(result.found).toBe(false);
      const cached = await kv.get("repocfg:acme/web", "json");
      expect(cached).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes the six candidate paths in spec order", () => {
    expect(REPO_CONFIG_PATHS).toEqual([
      ".uploads.yml",
      ".uploads.yaml",
      ".uploads.json",
      ".github/uploads.yml",
      ".github/uploads.yaml",
      ".github/uploads.json",
    ]);
  });

  it("exposes a 300-second TTL", () => {
    expect(REPO_CONFIG_TTL_SECONDS).toBe(300);
  });
});

describe("workspaceCommentDefaults", () => {
  it("maps workspace record fields, including both legacy booleans", () => {
    const ws: WorkspaceRecord = {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      githubCommentImageWidth: 480,
      githubCommentMaxInlineImages: 8,
      githubCommentNote: "hi",
      githubCommentLinkToFilePage: false,
      githubCommentShowMetadata: false,
    } as WorkspaceRecord;
    const defaults = workspaceCommentDefaults(ws);
    expect(defaults).toEqual({
      imageWidth: 480,
      maxInlineImages: 8,
      note: "hi",
      linkToFilePage: false,
      showMetadata: false,
    });
  });

  it("leaves fields absent when the record has none set", () => {
    const ws: WorkspaceRecord = {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
    } as WorkspaceRecord;
    const defaults = workspaceCommentDefaults(ws);
    expect(defaults).toEqual({});
  });
});

describe("resolveRepoCommentOptions", () => {
  it("resolves end-to-end: repo full-width overrides workspace px default", async () => {
    const kv = new FakeKv();
    const pem = await testPem();
    const env = makeEnv(kv, pem);
    const { impl } = fakeFetch({
      "/access_tokens": tokenRoute,
      "/installation": installationRoute,
      "/contents/.uploads.yml": () =>
        new Response("comment:\n  imageWidth: full\n", { status: 200 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const ws: WorkspaceRecord = {
        provider: "r2",
        bucket: "shared",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        githubCommentImageWidth: 320,
      } as WorkspaceRecord;
      const {
        options,
        source,
        fetch: fetchResult,
      } = await resolveRepoCommentOptions(env, ws, "acme/web");
      expect(options.imageWidth).toBe("full");
      expect(source.imageWidth).toBe("repo");
      expect(fetchResult.found).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades to workspace-defaults-only, uncached, when the App is not configured", async () => {
    const kv = new FakeKv();
    const env = { GITHUB_CACHE: kv } as unknown as Env;
    const ws: WorkspaceRecord = {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      githubCommentImageWidth: 320,
    } as WorkspaceRecord;
    const { options, source } = await resolveRepoCommentOptions(env, ws, "acme/web");
    expect(options.imageWidth).toBe(320);
    expect(source.imageWidth).toBe("workspace");
    const cached = await kv.get("repocfg:acme/web", "json");
    expect(cached).toBeNull();
  });
});
