import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { usagePeriodStart } from "../src/usage";
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

async function makeEnv() {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
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

describe("GET /v1/:workspace/usage + put/delete metering", () => {
  it("returns zeros before any uploads", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/v1/default/usage", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace: "default",
      bytes: 0,
      objects: 0,
      uploadsInPeriod: 0,
      periodStart: usagePeriodStart(),
      // Legacy KV-hash token (this suite's TOKEN) → full file-scope set.
      scopes: ["files:read", "files:write", "files:delete"],
    });
  });

  it("tracks put then delete against the ledger", async () => {
    const { env } = await makeEnv();

    const put = await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PUT",
        headers: { ...auth, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    expect(put.status).toBe(201);
    const putBody = (await put.json()) as { key: string };

    let usage = await (await app.request("/v1/default/usage", { headers: auth }, env)).json();
    expect(usage).toMatchObject({
      bytes: PNG.byteLength,
      objects: 1,
      uploadsInPeriod: 1,
    });

    const del = await app.request(
      `/v1/default/files/${putBody.key}`,
      { method: "DELETE", headers: auth },
      env,
    );
    expect(del.status).toBe(200);

    usage = await (await app.request("/v1/default/usage", { headers: auth }, env)).json();
    expect(usage).toMatchObject({ bytes: 0, objects: 0, uploadsInPeriod: 1 });
  });

  it("requires auth", async () => {
    const { env } = await makeEnv();
    expect((await app.request("/v1/default/usage", {}, env)).status).toBe(401);
  });
});
