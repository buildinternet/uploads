import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { UsageFakeD1 } from "./usage-fake-d1";
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

/**
 * Wraps `UsageFakeD1` (which keeps a real workspace_usage ledger) so
 * `batch()` throws for the `file_metadata` write batch specifically —
 * simulating replaceFileMetadata's db.batch() failing (e.g. a transient D1
 * error) on an otherwise-valid request. `prepare` and `batch` on
 * `UsageFakeD1` are instance fields (arrow functions), not prototype
 * methods, so this composes over an instance rather than subclassing (a
 * `super.prepare()` call would not resolve). Tags each prepared statement
 * with its source SQL at `prepare()` time so `batch()` can tell which table
 * a given call's statements target.
 */
function failingMetadataBatchD1() {
  const inner = new UsageFakeD1();
  const prepare = (sql: string) => {
    const stmt = inner.prepare(sql) as unknown as Record<string, unknown>;
    stmt.__sql = sql;
    return stmt;
  };
  const batch = async (statements: { run: () => Promise<unknown>; __sql?: string }[]) => {
    if (statements.some((s) => s.__sql?.includes("file_metadata"))) {
      throw new Error("simulated D1 batch failure");
    }
    return inner.batch(statements);
  };
  return { inner, prepare, batch };
}

async function makeEnv(db: { prepare: unknown; batch: unknown }) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
  };
  const bucket = new FakeR2Bucket();
  return {
    env: {
      REGISTRY: { get: async () => record, put: async () => undefined },
      DB: db,
      UPLOADS_DEFAULT: bucket,
      WRITE_LIMITER: { limit: async () => ({ success: true }) },
    },
    bucket,
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("PUT /v1/:workspace/files usage accounting survives a metadata failure", () => {
  it("still records usage when the custom-metadata D1 batch throws", async () => {
    const { inner: db, prepare, batch } = failingMetadataBatchD1();
    const { env, bucket } = await makeEnv({ prepare, batch });

    const res = await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": "image/png",
          "X-Uploads-Meta-App": "myapp",
        },
        body: PNG,
      },
      env,
    );

    // The metadata batch failure propagates as a 5xx — the object is stored
    // (files-core stores to R2 before touching D1) but the response reports
    // the failure rather than a false 201.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(true);

    // The whole point of the fix: usage accounting isn't skipped just
    // because the metadata write failed afterward.
    const usageRow = db.usage.get("default");
    expect(usageRow).toBeDefined();
    expect(usageRow?.bytes).toBe(PNG.byteLength);
    expect(usageRow?.objects).toBe(1);
    expect(usageRow?.uploads_in_period).toBe(1);
  });
});
