import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { app } from "../src/index";
import { getFileMetadata } from "../src/file-metadata";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

const TOKEN = "secret-token";

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/**
 * Fake D1 that no-ops the usage-ledger surface (as before) but backs
 * `file_metadata` with a real in-memory store (via the shared
 * `FileMetadataTable`), so the metadata-cascade behavior in
 * `putObject`/`deleteObject` can be exercised at the route level without a
 * full sqlite-backed D1 (see file-metadata-sqlite.test.ts for that).
 */
/** Optional scoped auth_tokens row, backing `findActiveToken` for scope-enforcement tests. */
interface FakeAuthToken {
  tokenHash: string;
  scopes: string;
  mintingUserId?: string;
}

function makeFakeDB(authToken?: FakeAuthToken) {
  const table = new FileMetadataTable();

  return {
    metadata: table.metadata,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first() {
          if (normalized.startsWith("SELECT id, workspace, token_hash") && authToken) {
            const [, hash] = args as [string, string, string];
            if (hash === authToken.tokenHash) {
              return {
                id: "token-id",
                workspace: "default",
                token_hash: authToken.tokenHash,
                label: null,
                scopes: authToken.scopes,
                created_at: "2026-07-13T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
                minting_user_id: authToken.mintingUserId ?? null,
              };
            }
          }
          return null;
        },
        async run() {
          return (
            table.tryRun(normalized, args) ?? { success: true, meta: { changes: 0 }, results: [] }
          );
        },
        async all<T>() {
          return (
            table.tryAll<T>(normalized, args) ?? { success: true, results: [] as T[], meta: {} }
          );
        },
      };
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
}

async function makeEnv(
  overrides: Partial<WorkspaceRecord> = {},
  opts: {
    rateLimitOk?: boolean;
    scopedToken?: { rawToken: string; scopes: string[]; mintingUserId?: string };
  } = {},
) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
    ...overrides,
  };
  const bucket = new FakeR2Bucket();
  // A `scopedToken` gives findActiveToken a D1-backed row for a *different*
  // raw token than the legacy TOKEN above, so scope-enforcement tests can
  // exercise a token with fewer than the full FILE_SCOPES set (the legacy
  // path always grants all scopes).
  const db = makeFakeDB(
    opts.scopedToken
      ? {
          tokenHash: await sha256Hex(opts.scopedToken.rawToken),
          scopes: JSON.stringify(opts.scopedToken.scopes),
          mintingUserId: opts.scopedToken.mintingUserId,
        }
      : undefined,
  );
  const env = {
    REGISTRY: { get: async () => record, put: async () => undefined },
    // No D1 token: force the legacy token path. run/batch no-op for usage
    // metering; file_metadata reads/writes are backed by makeFakeDB's store.
    DB: db,
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: opts.rateLimitOk ?? true }) },
    WEB_ORIGIN: "https://uploads.sh",
    // Uploader attribution (issue #340) defaults: empty login cache, no
    // linked GitHub account. Individual tests override these.
    GITHUB_CACHE: { get: async () => null, put: async () => undefined },
    AUTH: {
      fetch: async () =>
        new Response(JSON.stringify({ githubAccountId: null }), {
          headers: { "content-type": "application/json" },
        }),
    },
  };
  return { env, bucket, db };
}

/** PUT the standard test key with auth, letting each test vary body/headers/env. */
function putShot(
  env: Parameters<typeof app.request>[2],
  { body = PNG as BodyInit, headers = {} as Record<string, string> } = {},
) {
  // Nested key so auto-prefix of bare basenames does not rewrite the path.
  return app.request(
    "/v1/default/files/screenshots/shot.png",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png", ...headers },
      body,
    },
    env,
  );
}

describe("PUT /v1/:workspace/files upload guardrails", () => {
  it("stores a valid image with the sniffed content type", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      contentType: string;
      url: string;
      embedUrl: string | null;
      key: string;
    };
    expect(json.contentType).toBe("image/png");
    expect(json.key).toBe("screenshots/shot.png");
    expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
    expect(json.embedUrl).toBe("https://embed.uploads.sh/default/screenshots/shot.png");
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(true);
  });

  it("overrides a lying Content-Type header with the sniffed type", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env, { headers: { "Content-Type": "image/svg+xml" } });
    expect(res.status).toBe(201);
    expect(bucket.store.get("default/screenshots/shot.png")?.contentType).toBe("image/png");
  });

  it("rejects a non-image payload with 415", async () => {
    const { env } = await makeEnv();
    const res = await putShot(env, { body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]) }); // zip
    expect(res.status).toBe(415);
  });

  it("rejects an oversized body with 413", async () => {
    const { env } = await makeEnv({ maxUploadBytes: 4 });
    const res = await putShot(env);
    expect(res.status).toBe(413);
  });

  it("rejects on an oversized Content-Length before buffering", async () => {
    const { env } = await makeEnv({ maxUploadBytes: 4 });
    const res = await putShot(env, { headers: { "Content-Length": "999999" } });
    expect(res.status).toBe(413);
  });

  it("rejects an empty body with 400", async () => {
    const { env } = await makeEnv();
    const res = await putShot(env, { body: new Uint8Array(0) });
    expect(res.status).toBe(400);
  });

  it("returns 429 when the write rate limit is exceeded", async () => {
    const { env } = await makeEnv({}, { rateLimitOk: false });
    const res = await putShot(env);
    expect(res.status).toBe(429);
  });

  it("dry run resolves the key + public URL without writing", async () => {
    const { env, bucket } = await makeEnv();
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png?dryRun=1",
      { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(0) },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      key: string;
      url: string;
      embedUrl: string | null;
      dryRun: boolean;
      replaced: boolean;
    };
    expect(json).toEqual({
      workspace: "default",
      key: "screenshots/shot.png",
      url: "https://storage.uploads.sh/default/screenshots/shot.png",
      embedUrl: "https://embed.uploads.sh/default/screenshots/shot.png",
      replaced: false,
      dryRun: true,
    });
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
  });

  it("dry run reports replaced=true when the key already exists", async () => {
    const { env } = await makeEnv();
    expect((await putShot(env)).status).toBe(201);
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png?dryRun=1",
      { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(0) },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replaced: boolean; dryRun: boolean }).replaced).toBe(true);
  });

  it("dry run rejects a key the workspace policy disallows", async () => {
    const { env } = await makeEnv({ allowedKeyPrefixes: ["gh"] });
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png?dryRun=1",
      { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(0) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("stores allowlisted provenance metadata and returns it on put + head", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env, {
      headers: {
        "X-Uploads-Meta-Client": "uploads-cli",
        "X-Uploads-Meta-Client-Version": "0.3.0",
        "X-Uploads-Meta-Optimized": "1",
        "X-Uploads-Meta-Frame": "phone",
        // Non-allowlisted: lands in D1 custom metadata, never in R2 provenance.
        "X-Uploads-Meta-Secret": "custom-not-provenance",
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { metadata?: Record<string, string> };
    expect(json.metadata).toMatchObject({
      client: "uploads-cli",
      "client-version": "0.3.0",
      optimized: "1",
      frame: "phone",
    });
    expect(json.metadata?.["content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(json.metadata?.["content-sha256"]).not.toBe("0".repeat(64));
    // R2 bag is provenance plus server-only keys (uploaded-at); put/head JSON
    // still returns the allowlisted provenance subset only.
    const storedMeta = bucket.store.get("default/screenshots/shot.png")?.customMetadata;
    expect(storedMeta).toMatchObject(json.metadata!);
    expect(storedMeta?.["uploaded-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const head = await app.request(
      "/v1/default/files/screenshots/shot.png",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(head.status).toBe(200);
    const headJson = (await head.json()) as {
      contentType: string;
      metadata?: Record<string, string>;
      key: string;
    };
    expect(headJson.key).toBe("screenshots/shot.png");
    expect(headJson.contentType).toBe("image/png");
    expect(headJson.metadata).toEqual(json.metadata);
    expect(headJson.metadata).not.toHaveProperty("uploaded-at");
  });

  it("stores private visibility from the upload header and surfaces it on authed head", async () => {
    const { env } = await makeEnv();
    const res = await putShot(env, { headers: { "X-Uploads-Visibility": "private" } });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { visibility?: string };
    expect(json.visibility).toBe("private");

    const head = await app.request(
      "/v1/default/files/screenshots/shot.png",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const headJson = (await head.json()) as { visibility?: string };
    expect(headJson.visibility).toBe("private");
  });

  it("ignores an invalid visibility header value (stays public)", async () => {
    const { env } = await makeEnv();
    const res = await putShot(env, { headers: { "X-Uploads-Visibility": "hidden" } });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { visibility?: string };
    expect(json.visibility).toBeUndefined();
  });

  it("always sets content-sha256 even without client provenance headers", async () => {
    const { env } = await makeEnv();
    const res = await putShot(env);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { metadata?: Record<string, string> };
    expect(json.metadata?.["content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("PUT /v1/:workspace/files custom metadata capture + cascade", () => {
  it("splits non-allowlisted X-Uploads-Meta-* headers into D1 while keeping allowlisted ones as R2 provenance", async () => {
    const { env, db, bucket } = await makeEnv();
    const res = await putShot(env, {
      headers: { "X-Uploads-Meta-App": "web", "X-Uploads-Meta-Client": "cli" },
    });
    expect(res.status).toBe(201);

    const json = (await res.json()) as { metadata?: Record<string, string> };
    expect(json.metadata?.client).toBe("cli");
    expect(json.metadata?.app).toBeUndefined();
    expect(bucket.store.get("default/screenshots/shot.png")?.customMetadata?.app).toBeUndefined();

    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web" });
  });

  it("rejects an upload with more than the custom metadata key cap, writing nothing", async () => {
    const { env, db, bucket } = await makeEnv();
    const headers: Record<string, string> = {};
    for (let i = 0; i < 25; i++) headers[`X-Uploads-Meta-k${i}`] = "v";

    const res = await putShot(env, { headers });
    expect(res.status).toBe(400);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({});
  });

  it("rejects an upload with an invalid custom metadata key, writing nothing", async () => {
    const { env, bucket } = await makeEnv();
    // Keys must start with a letter (META_KEY_RE) — "1bad" does not.
    const res = await putShot(env, { headers: { "X-Uploads-Meta-1bad": "x" } });
    expect(res.status).toBe(400);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
  });

  it("rejects an upload spoofing the server-set content-sha256 as custom metadata", async () => {
    const { env, db, bucket } = await makeEnv();
    const res = await putShot(env, {
      headers: { "X-Uploads-Meta-Content-Sha256": "0".repeat(64) },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_reserved_key");
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({});
  });

  it("rejects an upload trying to shadow the R2 visibility gate as custom metadata", async () => {
    const { env, db, bucket } = await makeEnv();
    const res = await putShot(env, {
      headers: { "X-Uploads-Meta-Visibility": "private" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_reserved_key");
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({});
  });

  it("rejects an empty custom metadata value instead of silently dropping it", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env, { headers: { "X-Uploads-Meta-App": "" } });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_invalid_value");
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
  });

  it("still ignores an empty value on an allowlisted provenance header (unchanged lenience)", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env, { headers: { "X-Uploads-Meta-Client": "" } });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { metadata?: Record<string, string> };
    expect(json.metadata?.client).toBeUndefined();
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(true);
  });

  it("writes no custom metadata rows on a dry run", async () => {
    const { env, db } = await makeEnv();
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png?dryRun=1",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "X-Uploads-Meta-App": "web" },
        body: new Uint8Array(0),
      },
      env,
    );
    expect(res.status).toBe(200);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({});
  });

  it("cascades: DELETE removes the object's custom metadata rows", async () => {
    const { env, db } = await makeEnv();
    const putRes = await putShot(env, { headers: { "X-Uploads-Meta-App": "web" } });
    expect(putRes.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web" });

    const del = await app.request(
      "/v1/default/files/screenshots/shot.png",
      { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(del.status).toBe(200);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({});
  });

  it("sets replaced=false on first put and replaced=true on overwrite", async () => {
    const { env } = await makeEnv();
    const first = await putShot(env);
    expect(first.status).toBe(201);
    expect(((await first.json()) as { replaced: boolean }).replaced).toBe(false);

    const second = await putShot(env);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { replaced: boolean }).replaced).toBe(true);
  });

  it("re-PUT with at least one custom header still fully replaces prior custom metadata", async () => {
    const { env, db } = await makeEnv();
    const first = await putShot(env, {
      headers: { "X-Uploads-Meta-App": "web", "X-Uploads-Meta-Page": "/checkout" },
    });
    expect(first.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web", page: "/checkout" });

    const second = await putShot(env, { headers: { "X-Uploads-Meta-Page": "/cart" } });
    expect(second.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ page: "/cart" });
  });

  it("re-PUT with no custom headers preserves prior custom metadata", async () => {
    const { env, db } = await makeEnv();
    const first = await putShot(env, {
      headers: { "X-Uploads-Meta-App": "web", "X-Uploads-Meta-Page": "/checkout" },
    });
    expect(first.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web", page: "/checkout" });

    // No X-Uploads-Meta-* headers at all — not even a provenance-only one.
    const second = await putShot(env);
    expect(second.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web", page: "/checkout" });
  });

  it("re-PUT with only allowlisted provenance headers (no custom keys) preserves prior custom metadata", async () => {
    const { env, db } = await makeEnv();
    const first = await putShot(env, { headers: { "X-Uploads-Meta-App": "web" } });
    expect(first.status).toBe(201);

    // "client" is an allowlisted provenance key, not custom metadata.
    const second = await putShot(env, { headers: { "X-Uploads-Meta-Client": "cli" } });
    expect(second.status).toBe(201);
    await expect(
      getFileMetadata(db as unknown as D1Database, "default", "screenshots/shot.png"),
    ).resolves.toEqual({ app: "web" });
  });
});

function getMeta(env: Parameters<typeof app.request>[2], key: string, token = TOKEN) {
  return app.request(
    `/v1/default/files/${key}?metadata=1`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

function patchMeta(
  env: Parameters<typeof app.request>[2],
  key: string,
  body: { set?: Record<string, string>; delete?: string[] },
  token = TOKEN,
) {
  return app.request(
    `/v1/default/files/${key}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("GET ?metadata=1 / PATCH /v1/:workspace/files/:key", () => {
  it("GET returns an empty map for an object with no metadata", async () => {
    const { env } = await makeEnv();
    const put = await putShot(env);
    expect(put.status).toBe(201);

    const res = await getMeta(env, "screenshots/shot.png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metadata: {} });
  });

  it("GET 404s when the object does not exist", async () => {
    const { env } = await makeEnv();
    const res = await getMeta(env, "screenshots/missing.png");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("not_found");
  });

  it("PATCH set then GET round-trips the value", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const patch = await patchMeta(env, "screenshots/shot.png", { set: { gh_pr: "142" } });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ metadata: { gh_pr: "142" } });

    const res = await getMeta(env, "screenshots/shot.png");
    expect(await res.json()).toEqual({ metadata: { gh_pr: "142" } });
  });

  it("PATCH rejects setting the reserved content-sha256 key with 400", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const patch = await patchMeta(env, "screenshots/shot.png", {
      set: { "content-sha256": "0".repeat(64) },
    });
    expect(patch.status).toBe(400);
    const json = (await patch.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_reserved_key");

    const res = await getMeta(env, "screenshots/shot.png");
    expect(await res.json()).toEqual({ metadata: {} });
  });

  it("PATCH rejects setting the reserved visibility key with 400", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const patch = await patchMeta(env, "screenshots/shot.png", {
      set: { visibility: "private" },
    });
    expect(patch.status).toBe(400);
    const json = (await patch.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_reserved_key");

    const res = await getMeta(env, "screenshots/shot.png");
    expect(await res.json()).toEqual({ metadata: {} });
  });

  it("PATCH delete removes a key", async () => {
    const { env } = await makeEnv();
    await putShot(env);
    await patchMeta(env, "screenshots/shot.png", { set: { gh_pr: "142", app: "web" } });

    const patch = await patchMeta(env, "screenshots/shot.png", { delete: ["gh_pr"] });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ metadata: { app: "web" } });
  });

  it("PATCH past the 24-key cap is rejected with 4xx and leaves metadata untouched", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const set: Record<string, string> = {};
    for (let i = 0; i < 25; i++) set[`k${i}`] = "v";
    const patch = await patchMeta(env, "screenshots/shot.png", { set });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect(patch.status).toBeLessThan(500);

    const res = await getMeta(env, "screenshots/shot.png");
    expect(await res.json()).toEqual({ metadata: {} });
  });

  it("PATCH past the 8192 total-byte cap is rejected with 4xx", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    // 24 keys is within the key cap but the values push total bytes over 8192.
    const set: Record<string, string> = {};
    for (let i = 0; i < 20; i++) set[`k${i}`] = "v".repeat(500);
    const patch = await patchMeta(env, "screenshots/shot.png", { set });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect(patch.status).toBeLessThan(500);
  });

  it("PATCH on a missing object 404s", async () => {
    const { env } = await makeEnv();
    const patch = await patchMeta(env, "screenshots/missing.png", { set: { app: "web" } });
    expect(patch.status).toBe(404);
  });

  it("PATCH rejects a malformed body (non-object)", async () => {
    const { env } = await makeEnv();
    await putShot(env);
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("validation");
  });

  it("PATCH rejects a `set` with non-string values", async () => {
    const { env } = await makeEnv();
    await putShot(env);
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ set: { app: 42 } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("a read-scoped token can GET metadata but not PATCH it (403 insufficient_scope)", async () => {
    const READ_TOKEN = "read-only-token";
    const { env } = await makeEnv(
      {},
      { scopedToken: { rawToken: READ_TOKEN, scopes: ["files:read"] } },
    );
    await putShot(env);

    const get = await getMeta(env, "screenshots/shot.png", READ_TOKEN);
    expect(get.status).toBe(200);

    const patch = await patchMeta(env, "screenshots/shot.png", { set: { app: "web" } }, READ_TOKEN);
    expect(patch.status).toBe(403);
    const json = (await patch.json()) as { error: { type: string } };
    expect(json.error.type).toBe("insufficient_scope");
  });

  it("a token mixing an operator scope with a file scope grants no extra file permissions (issue #257)", async () => {
    // Regression for #257: a token minted with scopes ["files:read",
    // "operator:write"] must never grant the file route any more than a
    // files:read-only token would. `parseScopes` (auth-db.ts) requires
    // *every* entry in the stored array to be a valid FileScope
    // (`parsed.every(isFileScope)`), so the presence of the operator:write
    // scope makes the whole array fail validation and workspaceAuth
    // (workspace.ts) resolves `authScopes` to `[]` — fail-closed, not a
    // partial grant of files:read. Both PUT (files:write) and PATCH
    // (files:write) must stay 403, and — importantly — this token gets
    // *no* files:read reach either, confirming operator:write cannot be used
    // to smuggle in any file permission, read or write.
    const MIXED_TOKEN = "files-read-plus-operator-write-token";
    const { env } = await makeEnv(
      {},
      { scopedToken: { rawToken: MIXED_TOKEN, scopes: ["files:read", "operator:write"] } },
    );
    await putShot(env);

    // The mixed-scope token has no read access: the operator scope poisons the
    // whole scope set rather than being silently dropped in isolation.
    const get = await getMeta(env, "screenshots/shot.png", MIXED_TOKEN);
    expect(get.status).toBe(403);
    const getJson = (await get.json()) as { error: { type: string } };
    expect(getJson.error.type).toBe("insufficient_scope");

    // Nor does it get file-write access via the operator:write scope.
    const patch = await patchMeta(
      env,
      "screenshots/shot.png",
      { set: { app: "web" } },
      MIXED_TOKEN,
    );
    expect(patch.status).toBe(403);
    const patchJson = (await patch.json()) as { error: { type: string } };
    expect(patchJson.error.type).toBe("insufficient_scope");

    // Same for a raw PUT (also requires files:write).
    const put = await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${MIXED_TOKEN}`, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    expect(put.status).toBe(403);
    const putJson = (await put.json()) as { error: { type: string } };
    expect(putJson.error.type).toBe("insufficient_scope");
  });

  it("a plain files:read-only token still gets file-route read access (baseline for the mixed-scope case above)", async () => {
    const READ_ONLY_TOKEN = "files-read-only-token";
    const { env } = await makeEnv(
      {},
      { scopedToken: { rawToken: READ_ONLY_TOKEN, scopes: ["files:read"] } },
    );
    await putShot(env);
    const get = await getMeta(env, "screenshots/shot.png", READ_ONLY_TOKEN);
    expect(get.status).toBe(200);
  });

  it("GET ?metadata=1 / PATCH round-trip on a key with several raw slashes", async () => {
    const { env } = await makeEnv();
    const deepKey = "a/b/c/d/deep.png";
    const put = await app.request(
      `/v1/default/files/${deepKey}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    expect(put.status).toBe(201);

    const patch = await patchMeta(env, deepKey, { set: { app: "web" } });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ metadata: { app: "web" } });

    const res = await getMeta(env, deepKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metadata: { app: "web" } });
  });

  it("dryRun is a PUT-only param and has no effect on GET ?metadata=1", async () => {
    const { env } = await makeEnv();
    await putShot(env);
    await patchMeta(env, "screenshots/shot.png", { set: { app: "web" } });

    // dryRun only means anything on PUT; a stray dryRun=1 alongside
    // metadata=1 on a GET is simply ignored, not misread as a dry-run upload.
    const res = await app.request(
      "/v1/default/files/screenshots/shot.png?metadata=1&dryRun=1",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metadata: { app: "web" } });
  });
});

function listFiles(env: Parameters<typeof app.request>[2], qs: string) {
  return app.request(
    `/v1/default/files${qs}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
    env,
  );
}

interface ListedFile {
  key: string;
  url: string;
  metadata: Record<string, string>;
}

describe("GET /v1/:workspace/files list + meta.* filter", () => {
  it("no meta.* params: existing R2 prefix-list path is unchanged", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const res = await listFiles(env, "");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      items: Array<{ key: string; url: string; size: number; contentType: string }>;
      cursor: string | null;
    };
    expect(json.cursor).toBeNull();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      key: "screenshots/shot.png",
      url: "https://storage.uploads.sh/default/screenshots/shot.png",
      size: PNG.byteLength,
      contentType: "image/png",
    });
  });

  it("filters by a single meta.* param via D1", async () => {
    const { env } = await makeEnv();
    await putShot(env, { headers: { "X-Uploads-Meta-Device": "mobile" } });

    const res = await listFiles(env, "?meta.device=mobile");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: ListedFile[]; cursor: string | null };
    expect(json.cursor).toBeNull();
    expect(json.items).toEqual([
      {
        key: "screenshots/shot.png",
        url: "https://storage.uploads.sh/default/screenshots/shot.png",
        embedUrl: "https://embed.uploads.sh/default/screenshots/shot.png",
        metadata: { device: "mobile" },
      },
    ]);
  });

  it("ANDs two meta.* filters, excluding an object that matches only one", async () => {
    const { env } = await makeEnv();
    await putShot(env, {
      headers: { "X-Uploads-Meta-Device": "mobile", "X-Uploads-Meta-App": "screenshots" },
    });
    // Second object matches `device` but not `app`.
    await app.request(
      "/v1/default/files/other/shot2.png",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "image/png",
          "X-Uploads-Meta-Device": "mobile",
          "X-Uploads-Meta-App": "web",
        },
        body: PNG,
      },
      env,
    );

    const res = await listFiles(env, "?meta.device=mobile&meta.app=screenshots");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: ListedFile[] };
    expect(json.items).toHaveLength(1);
    expect(json.items[0].key).toBe("screenshots/shot.png");
  });

  it("combines a meta.* filter with a prefix", async () => {
    const { env } = await makeEnv();
    await putShot(env, { headers: { "X-Uploads-Meta-App": "screenshots" } });
    await app.request(
      "/v1/default/files/other/shot2.png",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "image/png",
          "X-Uploads-Meta-App": "screenshots",
        },
        body: PNG,
      },
      env,
    );

    const res = await listFiles(env, "?meta.app=screenshots&prefix=screenshots/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: ListedFile[] };
    expect(json.items).toEqual([
      {
        key: "screenshots/shot.png",
        url: "https://storage.uploads.sh/default/screenshots/shot.png",
        embedUrl: "https://embed.uploads.sh/default/screenshots/shot.png",
        metadata: { app: "screenshots" },
      },
    ]);
  });

  it("rejects an invalid meta.* key with a validation error", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const res = await listFiles(env, "?meta.1bad=x");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("validation");
  });

  it("rejects a repeated same-key meta.* param", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const res = await listFiles(env, "?meta.device=mobile&meta.device=desktop");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("validation");
  });

  it("rejects more than 24 meta.* filter params with a typed error", async () => {
    const { env } = await makeEnv();
    await putShot(env);

    const qs = "?" + Array.from({ length: 25 }, (_, i) => `meta.k${i}=v`).join("&");
    const res = await listFiles(env, qs);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; code: string; details: unknown } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("file_metadata_too_many_filters");
    expect(json.error.details).toEqual({ limit: 24, count: 25 });
  });
});

describe("PUT /v1/:workspace/files uploader attribution (issue #340)", () => {
  const SCOPED = "up_default_minted";

  function githubUserStub(login = "octocat") {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/user/")) {
        return new Response(JSON.stringify({ login }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  function withGithubAccount(env: Record<string, unknown>, accountId: string) {
    env.AUTH = {
      fetch: async () =>
        new Response(JSON.stringify({ githubAccountId: accountId }), {
          headers: { "content-type": "application/json" },
        }),
    };
  }

  it("stamps gh.uploader/gh.uploader-id from the token's minting user on gh.*-tagged uploads", async () => {
    const { env, db } = await makeEnv(
      {},
      { scopedToken: { rawToken: SCOPED, scopes: ["files:write"], mintingUserId: "user-1" } },
    );
    withGithubAccount(env as unknown as Record<string, unknown>, "583231");
    const restore = githubUserStub("octocat");
    try {
      const res = await putShot(env, {
        headers: {
          Authorization: `Bearer ${SCOPED}`,
          "X-Uploads-Meta-gh.repo": "acme/web",
          "X-Uploads-Meta-gh.kind": "branch",
          "X-Uploads-Meta-gh.branch": "feat/x",
          // A spoofed uploader loses to the server-derived identity.
          "X-Uploads-Meta-gh.uploader": "someone-else",
        },
      });
      expect(res.status).toBe(201);
      const meta = await getFileMetadata(
        db as unknown as D1Database,
        "default",
        "screenshots/shot.png",
      );
      expect(meta["gh.uploader"]).toBe("octocat");
      expect(meta["gh.uploader-id"]).toBe("user-1");
      expect(meta["gh.repo"]).toBe("acme/web");
    } finally {
      restore();
    }
  });

  it("degrades to the id-only tag when the user has no linked GitHub account", async () => {
    const { env, db } = await makeEnv(
      {},
      { scopedToken: { rawToken: SCOPED, scopes: ["files:write"], mintingUserId: "user-1" } },
    );
    const res = await putShot(env, {
      headers: { Authorization: `Bearer ${SCOPED}`, "X-Uploads-Meta-gh.repo": "acme/web" },
    });
    expect(res.status).toBe(201);
    const meta = await getFileMetadata(
      db as unknown as D1Database,
      "default",
      "screenshots/shot.png",
    );
    expect(meta["gh.uploader-id"]).toBe("user-1");
    expect(meta["gh.uploader"]).toBeUndefined();
  });

  it("leaves non-gh uploads untouched", async () => {
    const { env, db } = await makeEnv(
      {},
      { scopedToken: { rawToken: SCOPED, scopes: ["files:write"], mintingUserId: "user-1" } },
    );
    const res = await putShot(env, {
      headers: { Authorization: `Bearer ${SCOPED}`, "X-Uploads-Meta-page": "onboarding" },
    });
    expect(res.status).toBe(201);
    const meta = await getFileMetadata(
      db as unknown as D1Database,
      "default",
      "screenshots/shot.png",
    );
    expect(meta).toEqual({ page: "onboarding" });
  });

  it("legacy tokens (no minting user) get no uploader tags", async () => {
    const { env, db } = await makeEnv();
    const res = await putShot(env, { headers: { "X-Uploads-Meta-gh.repo": "acme/web" } });
    expect(res.status).toBe(201);
    const meta = await getFileMetadata(
      db as unknown as D1Database,
      "default",
      "screenshots/shot.png",
    );
    expect(meta).toEqual({ "gh.repo": "acme/web" });
  });
});

describe("uploader attribution never breaks a cap-limit upload (issue #340 review)", () => {
  it("drops the server tags instead of failing when the merge would exceed 24 keys", async () => {
    const SCOPED = "up_default_minted2";
    const { env, db } = await makeEnv(
      {},
      { scopedToken: { rawToken: SCOPED, scopes: ["files:write"], mintingUserId: "user-1" } },
    );
    // 24 client pairs (the cap), one of them gh.* so attribution triggers.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${SCOPED}`,
      "X-Uploads-Meta-gh.repo": "acme/web",
    };
    for (let i = 1; i <= 23; i++) headers[`X-Uploads-Meta-extra${i}`] = "v";
    const res = await putShot(env, { headers });
    expect(res.status).toBe(201);
    const meta = await getFileMetadata(
      db as unknown as D1Database,
      "default",
      "screenshots/shot.png",
    );
    expect(Object.keys(meta)).toHaveLength(24);
    expect(meta["gh.uploader-id"]).toBeUndefined();
  });
});
