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
    bucket,
    db,
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("POST /usage/reconcile", () => {
  it("rebuilds ledger totals from storage when metering drifted", async () => {
    const { env, bucket, db } = await makeEnv();
    // Object in R2 without going through put metering
    await bucket.put("default/orphan.png", PNG, { httpMetadata: { contentType: "image/png" } });
    db.usage.set("default", {
      workspace: "default",
      bytes: 9999,
      objects: 99,
      uploads_in_period: 7,
      period_start: "2026-07",
      updated_at: "2026-07-01T00:00:00.000Z",
    });

    const res = await app.request(
      "/v1/default/usage/reconcile",
      { method: "POST", headers: auth },
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bytes: number;
      objects: number;
      previous: { bytes: number; objects: number };
      changed: boolean;
      usage: { uploadsInPeriod: number; bytes: number };
    };
    expect(body.previous).toEqual({ bytes: 9999, objects: 99 });
    expect(body.bytes).toBe(PNG.byteLength);
    expect(body.objects).toBe(1);
    expect(body.changed).toBe(true);
    // Monthly upload counter preserved
    expect(body.usage.uploadsInPeriod).toBe(7);
    expect(body.usage.bytes).toBe(PNG.byteLength);
  });

  it("requires files:write", async () => {
    const { env } = await makeEnv();
    // No auth
    expect(
      (await app.request("/v1/default/usage/reconcile", { method: "POST" }, env as never)).status,
    ).toBe(401);
  });
});

describe("POST /usage/purge-expired", () => {
  it("skips when retentionDays is unset", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/default/usage/purge-expired",
      { method: "POST", headers: auth },
      env as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
  });

  it("deletes old objects and reconciles", async () => {
    const { env, bucket } = await makeEnv({ retentionDays: 30 });
    await bucket.put("default/old.png", PNG, { httpMetadata: { contentType: "image/png" } });
    await bucket.put("default/new.png", PNG, { httpMetadata: { contentType: "image/png" } });
    bucket.setUploaded("default/old.png", new Date("2020-01-01T00:00:00Z"));
    bucket.setUploaded("default/new.png", new Date());

    const res = await app.request(
      "/v1/default/usage/purge-expired",
      { method: "POST", headers: auth },
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: number;
      freedBytes: number;
      keys: string[];
      reconcile: { objects: number; bytes: number };
    };
    expect(body.deleted).toBe(1);
    expect(body.freedBytes).toBe(PNG.byteLength);
    expect(body.keys).toContain("old.png");
    expect(bucket.store.has("default/old.png")).toBe(false);
    expect(bucket.store.has("default/new.png")).toBe(true);
    expect(body.reconcile.objects).toBe(1);
    expect(body.reconcile.bytes).toBe(PNG.byteLength);
  });
});
