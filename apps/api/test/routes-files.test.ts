import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import app from "../src/index";
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
    // No D1 token: force the legacy token path.
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
      }),
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
  return app.request(
    "/v1/default/files/shot.png",
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
    const json = (await res.json()) as { contentType: string; url: string };
    expect(json.contentType).toBe("image/png");
    expect(json.url).toBe("https://storage.uploads.sh/default/shot.png");
    expect(bucket.store.has("default/shot.png")).toBe(true);
  });

  it("overrides a lying Content-Type header with the sniffed type", async () => {
    const { env, bucket } = await makeEnv();
    const res = await putShot(env, { headers: { "Content-Type": "image/svg+xml" } });
    expect(res.status).toBe(201);
    expect(bucket.store.get("default/shot.png")?.contentType).toBe("image/png");
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
});
