import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { UsageFakeD1 } from "./usage-fake-d1";

// Regression coverage for the BYO-bucket storage-budget fix: a self-serve
// BYO workspace is stamped `plan: "free"`, so once
// its ledger crosses the free-plan byte cap every upload used to fail with
// 507 `storage_quota_exceeded` — a hard outage for a customer paying their
// own R2 bill. The atomic reservation in `putObject` (files-core.ts) must
// enforce the cap against shared-lane residue for BYO records while still
// incrementing total usage and enforcing the per-period upload-count cap.
//
// A *real* BYO workspace record has no `binding` — I/O goes over an S3-style
// HTTP client (files-sdk's r2-http adapter), which this in-process test
// suite has no business making real network calls to. `storageBudgetApplies`
// / `enforcedMaxStorageBytes` (budget.ts) only ever inspect the
// WorkspaceRecord's own fields (`binding`/`accountId`/`accessKeyId`/
// `secretAccessKey`) — never how `./storage` actually opens the client — so
// this suite keeps the BYO record shape (no `binding`) for the budget logic
// under test, while mocking `../src/storage` to force every actual byte
// read/write through the same `FakeR2Bucket` the rest of the route-level
// suite (routes-budget.test.ts) already uses. That isolates "does the
// reservation skip the cap for a BYO-shaped record" from "how bytes
// physically move", which is exactly what this fix changes.
const fakeBucket = new FakeR2Bucket();

// Function declaration (not const) so the hoisted vi.mock factory below can
// reference it whenever the mocked module is first imported.
function forceBinding(ws: Record<string, unknown>) {
  return { ...ws, binding: "UPLOADS_DEFAULT" };
}

vi.mock("../src/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage")>();
  return {
    ...original,
    storageConfig: (env: unknown, ws: Record<string, unknown>) =>
      original.storageConfig(env as never, forceBinding(ws) as never),
    storage: (env: unknown, ws: Record<string, unknown>) =>
      original.storage(env as never, forceBinding(ws) as never),
  };
});

const { app } = await import("../src/index");

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

// BYO signal per `storageBudgetApplies` (budget.ts): HTTP credentials with
// no `binding`. See the module-level comment above for why storage I/O is
// still routed through a FakeR2Bucket via the `../src/storage` mock.
async function makeByoEnv(overrides: Partial<WorkspaceRecord> = {}) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "customer-bucket",
    publicBaseUrl: "https://customer-bucket.example.com",
    tokenHash: await sha256Hex(TOKEN),
    plan: "free",
    accountId: "a".repeat(32),
    accessKeyId: "customer-key",
    secretAccessKey: "customer-secret",
    ...overrides,
  };
  const db = new UsageFakeD1();
  return {
    env: {
      REGISTRY: { get: async () => record, put: async () => undefined },
      DB: db,
      UPLOADS_DEFAULT: fakeBucket,
      WRITE_LIMITER: { limit: async () => ({ success: true }) },
    },
    db,
  };
}

async function makeSharedEnv(overrides: Partial<WorkspaceRecord> = {}) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
    ...overrides,
  };
  const db = new UsageFakeD1();
  return {
    env: {
      REGISTRY: { get: async () => record, put: async () => undefined },
      DB: db,
      UPLOADS_DEFAULT: fakeBucket,
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

describe("BYO-bucket workspace storage budget attribution", () => {
  it("accepts an upload on a BYO workspace already over the free-plan byte cap, and still increments the ledger", async () => {
    const { env, db } = await makeByoEnv();

    // A first put establishes the workspace_usage row (real period_start,
    // real clock) so we don't have to hand-roll D1's period bookkeeping.
    expect((await put(env, "byo-first.png")).status).toBe(201);
    const row = db.usage.get("default");
    expect(row).toBeDefined();

    // Free plan's storage cap is 250_000_000 bytes — push usage past it
    // directly on the ledger, simulating a workspace that's been accruing
    // BYO-bucket bytes for a while.
    db.usage.set("default", { ...row!, bytes: 250_000_000 + 1_000 });

    const before = db.usage.get("default")!.bytes;
    const res = await put(env, "byo-second.png");
    expect(res.status).toBe(201);

    const after = db.usage.get("default")!.bytes;
    expect(after).toBe(before + PNG.byteLength);
  });

  it("still enforces maxUploadsPerPeriod on a BYO workspace", async () => {
    const { env, db } = await makeByoEnv({ maxUploadsPerPeriod: 1 });
    expect((await put(env, "byo-a.png")).status).toBe(201);
    expect(db.usage.get("default")?.uploads_in_period).toBe(1);

    const res = await put(env, "byo-b.png");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upload_budget_exceeded");
  });

  it("reports the shared-residue storage budget from GET /usage for a BYO workspace", async () => {
    const { env } = await makeByoEnv();
    await put(env, "byo-usage.png");
    const res = await app.request("/v1/default/usage", { headers: auth }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maxStorageBytes).toBe(250_000_000);
    expect(body.storageRemainingBytes).toBe(250_000_000);
  });

  it("still denies a shared-bucket (non-BYO) workspace over its cap with 507 storage_quota_exceeded", async () => {
    const { env } = await makeSharedEnv({ maxStorageBytes: PNG.byteLength - 1 });
    const res = await put(env, "shared.png");
    expect(res.status).toBe(507);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("storage_quota_exceeded");
  });
});
