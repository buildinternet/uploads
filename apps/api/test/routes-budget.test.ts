import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { UsageFakeD1 } from "./usage-fake-d1";

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
  const db = new UsageFakeD1();
  return {
    env: {
      REGISTRY: { get: async () => record, put: async () => undefined },
      DB: db,
      UPLOADS_DEFAULT: bucket,
      WRITE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

function put(env: unknown, key = "shot.png") {
  return app.request(
    `/v1/default/files/${key}`,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "image/png" },
      body: PNG,
    },
    env as never,
  );
}

describe("workspace budget enforcement", () => {
  it("returns 507 when a put would exceed maxStorageBytes", async () => {
    const { env } = await makeEnv({ maxStorageBytes: PNG.byteLength - 1 });
    const res = await put(env);
    expect(res.status).toBe(507);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string; details: { maxStorageBytes: number } };
    };
    expect(body.error.code).toBe("storage_quota_exceeded");
    expect(body.error.type).toBe("insufficient_storage");
    expect(body.error.details.maxStorageBytes).toBe(PNG.byteLength - 1);
  });

  it("returns 429 when monthly upload budget is spent", async () => {
    const { env, db } = await makeEnv({ maxUploadsPerPeriod: 1 });
    expect((await put(env, "a.png")).status).toBe(201);
    expect(db.usage.get("default")?.uploads_in_period).toBe(1);

    const res = await put(env, "b.png");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("upload_budget_exceeded");
    expect(body.error.type).toBe("rate_limited");
  });

  it("surfaces limits on GET /usage", async () => {
    const { env } = await makeEnv({
      maxStorageBytes: 10_000,
      maxUploadsPerPeriod: 50,
    });
    await put(env);
    const res = await app.request("/v1/default/usage", { headers: auth }, env as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bytes: PNG.byteLength,
      maxStorageBytes: 10_000,
      storageRemainingBytes: 10_000 - PNG.byteLength,
      maxUploadsPerPeriod: 50,
      uploadsRemaining: 49,
    });
  });

  it("allows unlimited workspaces (no limit fields)", async () => {
    const { env } = await makeEnv();
    expect((await put(env)).status).toBe(201);
  });
});
