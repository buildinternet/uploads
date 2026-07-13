import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

const TOKEN = "secret-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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

async function makeEnv(overrides: Partial<WorkspaceRecord> = {}) {
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
        async all() {
          return { success: true, results: [], meta: {} };
        },
      }),
      async batch(stmts: { run: () => Promise<unknown> }[]) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  };
  return { env, bucket };
}

function putKey(env: Parameters<typeof app.request>[2], key: string) {
  return app.request(
    `/v1/default/files/${key}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
      body: PNG,
    },
    env,
  );
}

describe("PUT key policy", () => {
  it("rejects keys outside allowedKeyPrefixes with 400", async () => {
    const { env } = await makeEnv({ allowedKeyPrefixes: ["screenshots", "gh"] });
    const res = await putKey(env, "tmp/shot.png");
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { code: string; details: { allowedKeyPrefixes: string[] } };
    };
    expect(json.error.code).toBe("key_prefix_not_allowed");
    expect(json.error.details.allowedKeyPrefixes).toContain("screenshots/");
  });

  it("allows keys under an allowed destination", async () => {
    const { env, bucket } = await makeEnv({ allowedKeyPrefixes: ["default"] });
    const res = await putKey(env, "screenshots/shot.png");
    expect(res.status).toBe(201);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(true);
  });

  it("rejects keys that exceed maxKeyDepth", async () => {
    const { env } = await makeEnv({ maxKeyDepth: 2 });
    const res = await putKey(env, "screenshots/a/b/shot.png");
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { code: string; details: { maxKeyDepth: number } };
    };
    expect(json.error.code).toBe("key_too_deep");
    expect(json.error.details.maxKeyDepth).toBe(2);
  });

  it("auto-prefix bare keys still works with f/ allowlist", async () => {
    const { env } = await makeEnv({ allowedKeyPrefixes: ["f"] });
    const res = await putKey(env, "shot.png");
    expect(res.status).toBe(201);
    const json = (await res.json()) as { key: string };
    expect(json.key).toMatch(/^f\/.+\/shot\.png$/);
  });
});
