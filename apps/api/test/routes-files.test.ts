import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { app } from "../src/index";
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

async function makeEnv(
  overrides: Partial<WorkspaceRecord> = {},
  opts: { rateLimitOk?: boolean } = {},
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
  const env = {
    REGISTRY: { get: async () => record, put: async () => undefined },
    // No D1 token: force the legacy token path. run/batch no-op for usage metering.
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true, meta: { changes: 0 }, results: [] };
        },
      }),
      async batch(stmts: { run: () => Promise<unknown> }[]) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: opts.rateLimitOk ?? true }) },
  };
  return { env, bucket };
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
    const json = (await res.json()) as { contentType: string; url: string; key: string };
    expect(json.contentType).toBe("image/png");
    expect(json.key).toBe("screenshots/shot.png");
    expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
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
    const json = (await res.json()) as { key: string; url: string; dryRun: boolean };
    expect(json).toEqual({
      workspace: "default",
      key: "screenshots/shot.png",
      url: "https://storage.uploads.sh/default/screenshots/shot.png",
      dryRun: true,
    });
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
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
        "X-Uploads-Meta-Secret": "should-drop",
        "X-Uploads-Meta-Content-Sha256": "0".repeat(64),
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
    expect(bucket.store.get("default/screenshots/shot.png")?.customMetadata).toEqual(json.metadata);

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
