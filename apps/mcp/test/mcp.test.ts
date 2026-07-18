import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";
import { resetOAuthJwksCacheForTests } from "../src/oauth";
import { GalleryFakeD1 } from "./gallery-fake-d1";

const TOKEN = "up_test-ws_legacy-token-value";
const ALPHA_TOKEN = "up_alpha_gallery-test";
const BETA_TOKEN = "up_beta_gallery-test";

const OAUTH_ISSUER = "https://auth.uploads.sh/api/auth";
const OAUTH_AUDIENCE = "https://agents.uploads.sh/mcp";
const OAUTH_KID = "test-key";

const workspace: WorkspaceRecord = {
  provider: "r2",
  bucket: "test-bucket",
  binding: "UPLOADS",
  publicBaseUrl: "https://storage.example.com",
};

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

/**
 * OAuth JWT test fixtures (issue #224): one RS256 key pair for the whole
 * suite, its public half served as the fake AS JWKS. `resetOAuthJwksCacheForTests`
 * runs between tests so the module-level 5-min cache in src/oauth.ts never
 * leaks a stale (or wrong-suite) key set across tests, and `fetch` is stubbed
 * per-test to return it instead of hitting the network — the test seam the
 * design calls for is `jwksFetcher`, but nothing in src/index.ts threads one
 * through, so stubbing global fetch (the thing src/oauth.ts's default
 * fetcher calls) exercises the real code path end-to-end.
 */
let oauthKeyPair: CryptoKeyPair;
let oauthJwks: { keys: JWK[] };

beforeAll(async () => {
  oauthKeyPair = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(oauthKeyPair.publicKey);
  oauthJwks = { keys: [{ ...publicJwk, kid: OAUTH_KID, alg: "RS256", use: "sig" }] };
});

beforeEach(() => {
  resetOAuthJwksCacheForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${OAUTH_ISSUER}/jwks`) {
        return new Response(JSON.stringify(oauthJwks), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signOAuthToken(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: OAUTH_KID })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? OAUTH_ISSUER)
    .setAudience(opts.audience ?? OAUTH_AUDIENCE)
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(oauthKeyPair.privateKey);
}

/**
 * Fake bindings following apps/api/test/routes-auth.test.ts: KV returns the
 * workspace record (only for the test-ws key), D1 returns a token row only
 * when configured AND the query is bound to test-ws (otherwise the legacy KV
 * token-hash path authenticates), R2 is an in-memory bucket. WRITE_LIMITER is
 * only bound when `rateLimitOk` is set, so most tests exercise the fail-open
 * path (mirrors apps/api/test/routes-files.test.ts).
 */
async function makeEnv(
  options: {
    d1?: { tokenHash: string; scopes: string };
    rateLimitOk?: boolean;
    record?: Partial<WorkspaceRecord>;
  } = {},
): Promise<{
  env: Env;
  bucket: FakeR2Bucket;
  metadata: Map<string, Map<string, string>>;
}> {
  const record: WorkspaceRecord = {
    ...workspace,
    tokenHash: await sha256Hex(TOKEN),
    ...options.record,
  };
  const bucket = new FakeR2Bucket();
  // Keyed by `${workspace} ${objectKey}` -> ordered meta_key -> meta_value,
  // real enough to exercise putObject's file_metadata read/write/delete path
  // (see apps/api/test/routes-files.test.ts's makeFakeDB for the fuller version).
  const metadata = new Map<string, Map<string, string>>();
  const scopeKey = (ws: string, objectKey: string) => `${ws} ${objectKey}`;
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === "ws:test-ws" ? record : null),
      put: async () => undefined,
    },
    DB: {
      // run() no-ops for workspace_usage metering; file_metadata reads/writes
      // are backed by the `metadata` map above.
      prepare: (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            const [ws, hash] = values as string[];
            const token = options.d1;
            if (ws === "test-ws" && token && token.tokenHash === hash) {
              return {
                id: "token-id",
                workspace: "test-ws",
                token_hash: token.tokenHash,
                label: null,
                scopes: token.scopes,
                created_at: "2026-07-10T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
              };
            }
            return null;
          },
          async run() {
            if (normalized.startsWith("INSERT INTO file_metadata")) {
              const [ws, objectKey, key, value] = values as [string, string, string, string];
              const map = metadata.get(scopeKey(ws, objectKey)) ?? new Map<string, string>();
              map.set(key, value);
              metadata.set(scopeKey(ws, objectKey), map);
            } else if (normalized.includes("meta_key = ?") && normalized.startsWith("DELETE")) {
              const [ws, objectKey, key] = values as [string, string, string];
              metadata.get(scopeKey(ws, objectKey))?.delete(key);
            } else if (normalized.startsWith("DELETE FROM file_metadata")) {
              const [ws, objectKey] = values as [string, string];
              metadata.delete(scopeKey(ws, objectKey));
            }
            return { success: true, meta: { changes: 0 }, results: [] };
          },
          async all<T>() {
            if (normalized.startsWith("SELECT meta_key, meta_value FROM file_metadata")) {
              const [ws, objectKey] = values as [string, string];
              const map = metadata.get(scopeKey(ws, objectKey)) ?? new Map<string, string>();
              return {
                success: true,
                results: [...map.entries()].map(([meta_key, meta_value]) => ({
                  meta_key,
                  meta_value,
                })) as T[],
                meta: {},
              };
            }
            // findObjectsByMetadata's first query: matches by ANDed key/value
            // pairs (+ optional escaped-LIKE prefix), grouped/having-counted.
            // Good enough for tests — not a general SQL engine.
            if (normalized.startsWith("SELECT object_key FROM file_metadata WHERE workspace")) {
              const vals = values as unknown[];
              const ws = vals[0] as string;
              const hasPrefix = normalized.includes("LIKE");
              const pairsEnd = hasPrefix ? vals.length - 3 : vals.length - 2;
              const pairs: Array<[string, string]> = [];
              for (let i = 1; i < pairsEnd; i += 2) {
                pairs.push([vals[i] as string, vals[i + 1] as string]);
              }
              const prefix = hasPrefix
                ? (vals[pairsEnd] as string).replace(/\\([%_\\])/g, "$1")
                : undefined;
              const limit = vals[vals.length - 1] as number;

              const matches: string[] = [];
              for (const [scoped, map] of metadata.entries()) {
                const [scopedWs, objectKey] = scoped.split(" ");
                if (scopedWs !== ws) continue;
                if (prefix !== undefined && !objectKey.startsWith(prefix)) continue;
                if (pairs.every(([k, v]) => map.get(k) === v)) matches.push(objectKey);
              }
              matches.sort();
              return {
                success: true,
                results: matches.slice(0, limit).map((object_key) => ({ object_key })) as T[],
                meta: {},
              };
            }
            // findObjectsByMetadata's hydrate query: full metadata for a set of keys.
            if (
              normalized.startsWith("SELECT object_key, meta_key, meta_value FROM file_metadata")
            ) {
              const [ws, ...keys] = values as string[];
              const results: Array<{
                object_key: string;
                meta_key: string;
                meta_value: string;
              }> = [];
              for (const objectKey of keys) {
                const map = metadata.get(scopeKey(ws, objectKey));
                if (!map) continue;
                for (const [meta_key, meta_value] of map.entries()) {
                  results.push({ object_key: objectKey, meta_key, meta_value });
                }
              }
              return { success: true, results: results as T[], meta: {} };
            }
            return { success: true, results: [] as T[], meta: {} };
          },
        };
      },
      async batch(stmts: { run: () => Promise<unknown> }[]) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    UPLOADS: bucket,
    ...(options.rateLimitOk === undefined
      ? {}
      : {
          WRITE_LIMITER: {
            limit: async () => ({ success: options.rateLimitOk }),
          },
        }),
  } as unknown as Env;
  return { env, bucket, metadata };
}

async function makeGalleryEnv(): Promise<{ env: Env; bucket: FakeR2Bucket }> {
  const bucket = new FakeR2Bucket();
  await bucket.put("alpha/screenshots/one.png", PNG_BYTES);
  const records: Record<string, WorkspaceRecord> = {
    alpha: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "alpha/",
      publicBaseUrl: "https://storage.example.com",
      tokenHash: await sha256Hex(ALPHA_TOKEN),
    },
    beta: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "beta/",
      publicBaseUrl: "https://storage.example.com",
      tokenHash: await sha256Hex(BETA_TOKEN),
    },
  };
  const env = {
    DB: new GalleryFakeD1(),
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: { get: async (key: string) => records[key.slice(3)] ?? null },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  return { env, bucket };
}

async function rpc(
  env: Env,
  body: unknown,
  token = TOKEN,
  path = "/test-ws/mcp",
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}` },
    },
    env,
  );
}

async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  token = TOKEN,
  path = "/test-ws/mcp",
) {
  const response = await rpc(
    env,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    token,
    path,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: unknown[];
    };
  };
  return body.result;
}

// A sniffable payload: the 8-byte PNG signature plus 3 filler bytes — 11 bytes.
// putObject sniffs the stored content type from these bytes (guards.ts).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

describe("hosted gallery tenant isolation", () => {
  it("keeps gallery get and reference lookup tenant-scoped while returning alpha canonical URLs", async () => {
    const { env } = await makeGalleryEnv();
    const alphaPath = "/alpha/mcp";
    const betaPath = "/beta/mcp";

    const created = await callTool(
      env,
      "gallery_create",
      { title: "Alpha launch" },
      ALPHA_TOKEN,
      alphaPath,
    );
    expect(created.isError).toBe(false);
    const gallery = created.structuredContent as {
      id: string;
      url: string;
      version: number;
    };
    expect(gallery.url).toBe("https://uploads.test/g/" + gallery.id);

    const added = await callTool(
      env,
      "gallery_add",
      { galleryId: gallery.id, objectKey: "screenshots/one.png" },
      ALPHA_TOKEN,
      alphaPath,
    );
    expect(added.structuredContent).toMatchObject({
      objectKey: "screenshots/one.png",
      url: "https://storage.example.com/alpha/screenshots/one.png",
    });

    const linked = await callTool(
      env,
      "gallery_link",
      {
        galleryId: gallery.id,
        provider: "github",
        coordinate: "buildinternet/uploads#57",
      },
      ALPHA_TOKEN,
      alphaPath,
    );
    expect(linked.structuredContent).toMatchObject({
      canonicalUrl: "https://github.com/buildinternet/uploads/issues/57",
    });

    const alphaFound = await callTool(
      env,
      "gallery_find_by_reference",
      { provider: "github", coordinate: "buildinternet/uploads#57" },
      ALPHA_TOKEN,
      alphaPath,
    );
    expect(alphaFound.structuredContent).toMatchObject({
      galleries: [{ id: gallery.id, url: gallery.url, version: 3 }],
      nextCursor: null,
    });

    const betaGet = await callTool(
      env,
      "gallery_get",
      { galleryId: gallery.id },
      BETA_TOKEN,
      betaPath,
    );
    expect(betaGet).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "gallery not found" }],
    });
    const betaFound = await callTool(
      env,
      "gallery_find_by_reference",
      { provider: "github", coordinate: "buildinternet/uploads#57" },
      BETA_TOKEN,
      betaPath,
    );
    expect(betaFound.structuredContent).toEqual({
      galleries: [],
      nextCursor: null,
    });
  });
});

describe("mcp worker", () => {
  it("serves an unauthenticated MCP server card for discovery", async () => {
    const { env } = await makeEnv();
    const response = await app.request("/.well-known/mcp/server-card.json", { method: "GET" }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      serverInfo: { name: string; version: string };
      transport: { type: string; endpoint: string };
      authentication: { required: boolean };
    };
    expect(body.serverInfo.name).toBe("uploads-mcp");
    expect(body.serverInfo.version).toBeTruthy();
    expect(body.transport.type).toBe("streamable-http");
    expect(body.transport.endpoint).toBe("https://agents.uploads.sh/mcp");
    expect(body.authentication.required).toBe(true);
  });

  it("serves OAuth Protected Resource Metadata (RFC 9728) for the MCP endpoint", async () => {
    const { env } = await makeEnv();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await app.request(
        `https://agents.uploads.sh${path}`,
        { method: "GET" },
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const body = (await response.json()) as {
        resource: string;
        scopes_supported: string[];
        bearer_methods_supported: string[];
        resource_documentation: string;
        authorization_servers?: unknown;
      };
      expect(body.resource).toBe("https://agents.uploads.sh/mcp");
      expect(body.scopes_supported).toEqual(["files:read", "files:write", "files:delete"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      expect(body.resource_documentation).toBe("https://uploads.sh/auth.md");
      // Only apps/mcp advertises an AS (issue #224) — it's the only resource
      // server that verifies uploads-auth OAuth JWTs. Defaults to the prod
      // issuer when AUTH_ORIGIN isn't set on the test env.
      expect(body.authorization_servers).toEqual(["https://auth.uploads.sh/api/auth"]);
    }
  });

  it("rejects a wrong token with a uniform 401 before any MCP handling", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        type: "unauthorized",
        message: "Authentication required.",
      },
    });
  });

  it("answers the initialize handshake", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("uploads-mcp");
  });

  it("lists exactly the remote tools", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "delete",
      "find_files",
      "gallery_add",
      "gallery_create",
      "gallery_find_by_reference",
      "gallery_get",
      "gallery_link",
      "get_metadata",
      "health",
      "list",
      "purge_expired",
      "put",
      "reconcile",
      "set_metadata",
      "usage",
    ]);
  });

  it("uploads base64 content and returns url + markdown", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      workspace: "test-ws",
      key: "shots/shot.png",
      url: "https://storage.example.com/shots/shot.png",
      size: 11,
      contentType: "image/png",
      markdown: "![shot.png](https://storage.example.com/shots/shot.png)",
    });
    expect(bucket.store.has("shots/shot.png")).toBe(true);
    expect(bucket.store.get("shots/shot.png")?.data).toEqual(PNG_BYTES);
    expect(bucket.store.get("shots/shot.png")?.contentType).toBe("image/png");
  });

  it("writes custom metadata alongside the upload", async () => {
    const { env, metadata } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
      metadata: { app: "myapp", page: "settings" },
    });
    expect(result.isError).toBe(false);
    expect(Object.fromEntries(metadata.get("test-ws shots/tagged.png") ?? [])).toEqual({
      app: "myapp",
      page: "settings",
    });
  });

  it("leaves existing metadata untouched when the metadata argument is omitted", async () => {
    const { env, metadata } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
      metadata: { app: "myapp" },
    });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
    });
    expect(result.isError).toBe(false);
    expect(Object.fromEntries(metadata.get("test-ws shots/tagged.png") ?? [])).toEqual({
      app: "myapp",
    });
  });

  it("rejects invalid metadata as a tool error before uploading", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/bad.png",
      metadata: { "Bad-Key": "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "invalid metadata key: Bad-Key (USAGE)" },
    ]);
    expect(bucket.store.size).toBe(0);
  });

  it("uploads multiple files in one call with per-item results", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      files: [
        { filename: "one.png", contentBase64: PNG_B64 },
        { filename: "two.png", contentBase64: PNG_B64, alt: "second shot" },
      ],
      prefix: "shots",
      repo: "acme/app",
      ref: "42",
    });
    expect(result.isError).toBe(false);
    const body = result.structuredContent as {
      workspace: string;
      uploads: Array<{
        file: string;
        key: string;
        url: string;
        markdown: string;
      }>;
      failures: unknown[];
    };
    expect(body.workspace).toBe("test-ws");
    expect(body.failures).toEqual([]);
    expect(body.uploads).toHaveLength(2);
    expect(body.uploads[0].file).toBe("one.png");
    expect(body.uploads[0].key).toMatch(/^shots\/acme-app\/42\/one-/);
    expect(body.uploads[0].markdown).toContain("![one.png](");
    expect(body.uploads[1].markdown).toContain("![second shot](");
    expect(bucket.store.size).toBe(2);
  });

  it("multi-file put returns partial failures without aborting the batch", async () => {
    const { env, bucket } = await makeEnv();
    const textB64 = btoa("not an image");
    const result = await callTool(env, "put", {
      files: [
        { filename: "good.png", contentBase64: PNG_B64 },
        { filename: "bad.txt", contentBase64: textB64 },
      ],
    });
    expect(result.isError).toBe(false);
    const body = result.structuredContent as {
      uploads: Array<{ file: string }>;
      failures: Array<{ file: string; error: { message: string } }>;
    };
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0].file).toBe("good.png");
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].file).toBe("bad.txt");
    expect(body.failures[0].error.message).toBeTruthy();
    expect(bucket.store.size).toBe(1);
  });

  it("multi-file total failure is isError with structured failures", async () => {
    const { env, bucket } = await makeEnv();
    const textB64 = btoa("not an image");
    const result = await callTool(env, "put", {
      files: [
        { filename: "a.txt", contentBase64: textB64 },
        { filename: "b.txt", contentBase64: textB64 },
      ],
    });
    expect(result.isError).toBe(true);
    const body = result.structuredContent as {
      uploads: unknown[];
      failures: Array<{ file: string }>;
    };
    expect(body.uploads).toEqual([]);
    expect(body.failures.map((f) => f.file)).toEqual(["a.txt", "b.txt"]);
    expect(bucket.store.size).toBe(0);
  });

  it("multi-file put rejects duplicate generated keys before any write", async () => {
    const { env, bucket } = await makeEnv();
    // Same filename + same content → same sanitized-name/content-hash key.
    const result = await callTool(env, "put", {
      files: [
        { filename: "shot.png", contentBase64: PNG_B64 },
        { filename: "shot.png", contentBase64: PNG_B64 },
      ],
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(
      /^files\[1\] \(shot\.png\) resolves to the same key as files\[0\] \(shot\.png\): /,
    );
    expect(bucket.store.size).toBe(0);
  });

  it("multi-file put pre-decode gate uses the video cap ceiling; per-item limits still apply", async () => {
    // Image cap below the 11-byte PNG, video cap above it: the batch must
    // decode (ceiling gate), then fail the PNG per item — not whole-batch.
    const { env, bucket } = await makeEnv({
      record: { maxUploadBytes: 8, maxVideoUploadBytes: 4096 },
    });
    const result = await callTool(env, "put", {
      files: [{ filename: "big.png", contentBase64: PNG_B64 }],
    });
    expect(result.isError).toBe(true);
    const body = result.structuredContent as {
      uploads: unknown[];
      failures: Array<{ file: string; error: { status?: number } }>;
    };
    expect(body.uploads).toEqual([]);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].file).toBe("big.png");
    expect(body.failures[0].error.status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });

  it("multi-file put rejects invalid combinations and shapes before writing", async () => {
    const { env, bucket } = await makeEnv();
    const combined = await callTool(env, "put", {
      files: [{ filename: "one.png", contentBase64: PNG_B64 }],
      contentBase64: PNG_B64,
      filename: "extra.png",
    });
    expect(combined.isError).toBe(true);
    expect(combined.content).toEqual([
      {
        type: "text",
        text: "contentBase64/filename cannot be combined with files (USAGE)",
      },
    ]);

    const withKey = await callTool(env, "put", {
      files: [{ filename: "one.png", contentBase64: PNG_B64 }],
      key: "shots/one.png",
    });
    expect(withKey.isError).toBe(true);
    expect(withKey.content).toEqual([
      { type: "text", text: "key cannot be combined with files (USAGE)" },
    ]);

    const overCap = await callTool(env, "put", {
      files: Array.from({ length: 21 }, (_, i) => ({
        filename: `f${i}.png`,
        contentBase64: PNG_B64,
      })),
    });
    expect(overCap.isError).toBe(true);
    expect(overCap.content).toEqual([
      {
        type: "text",
        text: "files supports at most 20 items per call (USAGE)",
      },
    ]);

    // One bad base64 item fails the whole batch before any write.
    const badBase64 = await callTool(env, "put", {
      files: [
        { filename: "one.png", contentBase64: PNG_B64 },
        { filename: "two.png", contentBase64: "%%%" },
      ],
    });
    expect(badBase64.isError).toBe(true);
    expect(badBase64.content).toEqual([
      {
        type: "text",
        text: "files[1] (two.png): contentBase64 must be valid base64 (USAGE)",
      },
    ]);
    expect(bucket.store.size).toBe(0);
  });

  it("get_metadata returns stored pairs, empty map, or not-found", async () => {
    const { env } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
      metadata: { app: "myapp", page: "/checkout" },
    });
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/plain.png",
    });

    const tagged = await callTool(env, "get_metadata", {
      key: "shots/tagged.png",
    });
    expect(tagged.isError).toBe(false);
    expect(tagged.structuredContent).toEqual({
      metadata: { app: "myapp", page: "/checkout" },
    });

    const plain = await callTool(env, "get_metadata", {
      key: "shots/plain.png",
    });
    expect(plain.isError).toBe(false);
    expect(plain.structuredContent).toEqual({ metadata: {} });

    const missing = await callTool(env, "get_metadata", {
      key: "shots/missing.png",
    });
    expect(missing.isError).toBe(true);
  });

  it("get_metadata enforces files:read scope", async () => {
    const token = "up_test-ws_write-only-token";
    const { env } = await makeEnv({
      d1: {
        tokenHash: await sha256Hex(token),
        scopes: JSON.stringify(["files:write"]),
      },
    });
    const result = await callTool(env, "get_metadata", { key: "shots/x.png" }, token);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "forbidden: requires files:read scope" },
    ]);
  });

  it("set_metadata merges set + delete and returns the resulting map", async () => {
    const { env, metadata } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
      metadata: { app: "myapp", page: "/checkout" },
    });

    const result = await callTool(env, "set_metadata", {
      key: "shots/tagged.png",
      set: { page: "/cart" },
      delete: ["app"],
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ metadata: { page: "/cart" } });
    expect(Object.fromEntries(metadata.get("test-ws shots/tagged.png") ?? [])).toEqual({
      page: "/cart",
    });
  });

  it("set_metadata requires at least one of set/delete", async () => {
    const { env } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
    });
    const result = await callTool(env, "set_metadata", {
      key: "shots/tagged.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "set_metadata requires set and/or delete (USAGE)" },
    ]);
  });

  it("set_metadata 404s for an object that doesn't exist", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "set_metadata", {
      key: "shots/missing.png",
      set: { app: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "object not found" }]);
  });

  it("set_metadata rejects a reserved key as a tool error", async () => {
    const { env } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/tagged.png",
    });
    const result = await callTool(env, "set_metadata", {
      key: "shots/tagged.png",
      set: { "content-sha256": "0".repeat(64) },
    });
    expect(result.isError).toBe(true);
  });

  it("set_metadata enforces files:write scope", async () => {
    const token = "up_test-ws_read-only-token";
    const { env } = await makeEnv({
      d1: {
        tokenHash: await sha256Hex(token),
        scopes: JSON.stringify(["files:read"]),
      },
    });
    const result = await callTool(
      env,
      "set_metadata",
      { key: "shots/x.png", set: { app: "x" } },
      token,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "forbidden: requires files:write scope" },
    ]);
  });

  it("find_files finds objects matching ALL ANDed filters, with public URLs", async () => {
    const { env } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/one.png",
      metadata: { app: "myapp", page: "/checkout" },
    });
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/two.png",
      metadata: { app: "myapp", page: "/cart" },
    });

    const result = await callTool(env, "find_files", {
      filters: { app: "myapp", page: "/checkout" },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      items: [
        {
          key: "shots/one.png",
          url: "https://storage.example.com/shots/one.png",
          metadata: { app: "myapp", page: "/checkout" },
        },
      ],
      cursor: null,
    });
  });

  it("find_files requires at least one filter", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "find_files", { filters: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "filters must have at least one key (USAGE)" },
    ]);
  });

  it("computes the default screenshot key without git derivation", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      repo: "acme/site",
      ref: "pr-7",
    });
    expect(result.isError).toBe(false);
    const key = result.structuredContent?.key as string;
    expect(key).toMatch(/^screenshots\/acme-site\/pr-7\/shot-[0-9a-f]{6}\.png$/);
    expect(bucket.store.has(key)).toBe(true);
  });

  it("lists uploaded objects with public urls, then deletes them", async () => {
    const { env, bucket } = await makeEnv();
    await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });

    const listed = await callTool(env, "list", { prefix: "shots/" });
    expect(listed.isError).toBe(false);
    const items = listed.structuredContent?.items as {
      key: string;
      url: string;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("shots/shot.png");
    expect(items[0].url).toBe("https://storage.example.com/shots/shot.png");

    const deleted = await callTool(env, "delete", { key: "shots/shot.png" });
    expect(deleted.isError).toBe(false);
    expect(deleted.structuredContent).toEqual({
      key: "shots/shot.png",
      deleted: true,
    });
    expect(bucket.store.size).toBe(0);
  });

  it("enforces token scopes inside tool handlers", async () => {
    const token = "up_test-ws_read-only-token";
    const { env, bucket } = await makeEnv({
      d1: {
        tokenHash: await sha256Hex(token),
        scopes: JSON.stringify(["files:read"]),
      },
    });
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png" },
      token,
    );
    expect(result.isError).toBe(true);
    // The shared usage() helper throws UploadsError, whose code the server
    // core appends to the tool error text.
    expect(result.content).toEqual([
      { type: "text", text: "forbidden: requires files:write scope" },
    ]);
    expect(bucket.store.size).toBe(0);

    const listed = await callTool(env, "list", {}, token);
    expect(listed.isError).toBe(false);
  });

  it("rejects an invalid explicit key as a tool error", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "../escape.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "invalid key" }]);
  });

  it("rejects unsupported bytes as a tool error (sniffed, not filename-trusted)", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(env, "put", {
      contentBase64: btoa("just some plain text"),
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("unsupported media type");
    expect(bucket.store.size).toBe(0);
  });

  it("rejects put with a rate-limit tool error when the write budget is spent", async () => {
    const { env, bucket } = await makeEnv({ rateLimitOk: false });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "rate limit exceeded" }]);
    expect(bucket.store.size).toBe(0);
  });

  it("uploads when the WRITE_LIMITER binding allows the write", async () => {
    const { env, bucket } = await makeEnv({ rateLimitOk: true });
    const result = await callTool(env, "put", {
      contentBase64: PNG_B64,
      filename: "shot.png",
      key: "shots/shot.png",
    });
    expect(result.isError).toBe(false);
    expect(bucket.store.has("shots/shot.png")).toBe(true);
  });

  it("rejects the same token against a different workspace path with 401", async () => {
    const { env } = await makeEnv();
    for (const path of ["/default/mcp", "/other-ws/mcp"]) {
      const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, TOKEN, path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "unauthorized",
          type: "unauthorized",
          message: "Authentication required.",
        },
      });
    }
  });

  it("answers health without a scope", async () => {
    const { env } = await makeEnv();
    const result = await callTool(env, "health", {});
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("returns 202 with an empty body for notifications", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects GET and DELETE on the endpoint (stateless: no SSE, no sessions)", async () => {
    const { env } = await makeEnv();
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(
        "/test-ws/mcp",
        { method, headers: { Authorization: `Bearer ${TOKEN}` } },
        env,
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({
        error: {
          code: "method_not_allowed",
          type: "method_not_allowed",
          message: "Method not allowed.",
        },
      });
    }
  });

  it("rejects a JSON array body with -32600 (batching removed from MCP)", async () => {
    const { env } = await makeEnv();
    const response = await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });
});

describe("token-inferred /mcp endpoint", () => {
  it("serves tool calls at /mcp with the workspace inferred from the token", async () => {
    const { env, bucket } = await makeEnv();
    const result = await (async () => {
      const response = await rpc(
        env,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "put",
            arguments: {
              contentBase64: PNG_B64,
              filename: "shot.png",
              key: "shots/shot.png",
            },
          },
        },
        TOKEN,
        "/mcp",
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: {
          isError: boolean;
          structuredContent?: Record<string, unknown>;
        };
      };
    })();
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent).toMatchObject({
      workspace: "test-ws",
      key: "shots/shot.png",
    });
    expect(bucket.store.has("shots/shot.png")).toBe(true);
  });

  it("rejects /mcp with a token for an unknown workspace", async () => {
    const { env } = await makeEnv();
    const response = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "up_other-ws_nope",
      "/mcp",
    );
    expect(response.status).toBe(401);
  });

  it("rejects /mcp with a malformed token (no workspace to infer)", async () => {
    const { env } = await makeEnv();
    for (const token of ["", "not-a-token", "up_", "up_test-ws"]) {
      const response = await rpc(
        env,
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        token,
        "/mcp",
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects GET and DELETE on /mcp", async () => {
    const { env } = await makeEnv();
    for (const method of ["GET", "DELETE"]) {
      const response = await app.request(
        "/mcp",
        { method, headers: { Authorization: `Bearer ${TOKEN}` } },
        env,
      );
      expect(response.status).toBe(405);
    }
  });
});

describe("OAuth JWT bearer (issue #224)", () => {
  it("accepts a valid JWT at the token-inferred /mcp endpoint, scoped to its granted scopes", async () => {
    const { env, bucket } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "test-ws",
      workspaces: ["test-ws"],
      scope: "files:read files:write",
    });
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png", key: "shots/shot.png" },
      jwt,
      "/mcp",
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ workspace: "test-ws", key: "shots/shot.png" });
    expect(bucket.store.has("shots/shot.png")).toBe(true);
  });

  it("accepts a lowercase `bearer` authentication scheme (RFC 9110: schemes are case-insensitive)", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "test-ws",
      workspaces: ["test-ws"],
      scope: "files:read",
    });
    const response = await app.request(
      "https://agents.uploads.sh/mcp",
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        headers: { Authorization: `bearer ${jwt}` },
      },
      env,
    );
    expect(response.status).toBe(200);
  });

  it("accepts a valid JWT at the path-based /:workspace/mcp endpoint when the path workspace is in `workspaces`", async () => {
    const { env, bucket } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "test-ws",
      workspaces: ["test-ws", "other-ws"],
      scope: "files:read files:write",
    });
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png", key: "shots/shot.png" },
      jwt,
      "/test-ws/mcp",
    );
    expect(result.isError).toBe(false);
    expect(bucket.store.has("shots/shot.png")).toBe(true);
  });

  it("rejects a JWT at /:workspace/mcp when the path workspace isn't in `workspaces`", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "other-ws",
      workspaces: ["other-ws"],
      scope: "files:read files:write",
    });
    const response = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      jwt,
      "/test-ws/mcp",
    );
    expect(response.status).toBe(401);
  });

  it("enforces the JWT's granted scopes inside tool handlers", async () => {
    const { env, bucket } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "test-ws",
      workspaces: ["test-ws"],
      scope: "files:read",
    });
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png" },
      jwt,
      "/mcp",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "forbidden: requires files:write scope" },
    ]);
    expect(bucket.store.size).toBe(0);
  });

  it("also accepts a `scopes` array claim (defensive against the AS emitting either shape)", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "test-ws",
      workspaces: ["test-ws"],
      scopes: ["files:read"],
    });
    const result = await callTool(env, "list", {}, jwt, "/mcp");
    expect(result.isError).toBe(false);
  });

  it("responds 403 with an actionable message when the token's user has no workspace", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: null,
      workspaces: [],
      scope: "files:read files:write",
    });
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, jwt, "/mcp");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("workspace_required");
    expect(body.error.message).toContain("uploads.sh");
  });

  it("401s with a discovery challenge (no error attribute) when no credential is presented", async () => {
    const { env } = await makeEnv();
    const response = await app.request(
      "https://agents.uploads.sh/mcp",
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) },
      env,
    );
    expect(response.status).toBe(401);
    // RFC 6750 §3.1: a request with NO credential must not get `invalid_token`.
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://agents.uploads.sh/.well-known/oauth-protected-resource"',
    );
  });

  it("401s with an RFC 9728 discovery challenge for a bad-issuer JWT", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken(
      { sub: "user-1", workspace: "test-ws", workspaces: ["test-ws"], scope: "files:read" },
      { issuer: "https://evil.example.com/api/auth" },
    );
    const response = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      jwt,
      "https://agents.uploads.sh/mcp",
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://agents.uploads.sh/.well-known/oauth-protected-resource"',
    );
  });

  it("401s with a discovery challenge for a bad-audience JWT", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken(
      { sub: "user-1", workspace: "test-ws", workspaces: ["test-ws"], scope: "files:read" },
      { audience: "https://not-uploads.example.com/mcp" },
    );
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, jwt, "/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("401s with a discovery challenge for an expired JWT", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken(
      { sub: "user-1", workspace: "test-ws", workspaces: ["test-ws"], scope: "files:read" },
      { expiresIn: "-1s" },
    );
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, jwt, "/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("401s for a JWT naming a workspace the registry no longer has", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken({
      sub: "user-1",
      workspace: "deleted-ws",
      workspaces: ["deleted-ws"],
      scope: "files:read",
    });
    const response = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, jwt, "/mcp");
    expect(response.status).toBe(401);
  });

  it("accepts the mcp.uploads.sh alternate audience too", async () => {
    const { env } = await makeEnv();
    const jwt = await signOAuthToken(
      { sub: "user-1", workspace: "test-ws", workspaces: ["test-ws"], scope: "files:read" },
      { audience: "https://mcp.uploads.sh/mcp" },
    );
    const result = await callTool(env, "list", {}, jwt, "/mcp");
    expect(result.isError).toBe(false);
  });

  it("still authenticates the legacy up_ token path unaffected by the JWT lane", async () => {
    const { env, bucket } = await makeEnv();
    const result = await callTool(
      env,
      "put",
      { contentBase64: PNG_B64, filename: "shot.png", key: "shots/legacy.png" },
      TOKEN,
      "/mcp",
    );
    expect(result.isError).toBe(false);
    expect(bucket.store.has("shots/legacy.png")).toBe(true);
  });
});
