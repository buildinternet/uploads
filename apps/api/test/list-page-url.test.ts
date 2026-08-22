import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { listObjects } from "../src/files-core";
import type { StorageLane, WorkspaceRecord } from "../src/workspace";

// `Env` is a global ambient type (apps/api/src/env.d.ts) — no import needed.
function makeEnv(bucket: FakeR2Bucket) {
  return { UPLOADS_DEFAULT: bucket, WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;
}

const baseRecord: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "default/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("listObjects pageUrl", () => {
  it("emits a /f/ pageUrl for public-url objects when the record carries a slug", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const env = makeEnv(bucket);
    const record: WorkspaceRecord = { ...baseRecord, name: "acme" };
    const { items } = await listObjects(env, record, {
      prefix: "gh/o/r/pull/1/",
    });
    expect(items[0].pageUrl).toBe("https://uploads.sh/f/acme/gh/o/r/pull/1/a.png");
  });

  it("omits pageUrl when the record has no slug", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const { items } = await listObjects(makeEnv(bucket), baseRecord, {
      prefix: "gh/o/r/pull/1/",
    });
    expect(items[0].pageUrl).toBeUndefined();
  });
});

// Task C4 (two-lane storage, PR C): merged multi-lane listing with a
// composite cursor. See
// docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Listing:
// merged fan-out".
describe("listObjects two-lane fan-out", () => {
  const FALLBACK_LANE: StorageLane = {
    id: "lane_fallback1",
    provider: "r2",
    bucket: "customer-bucket",
    binding: "UPLOADS_FALLBACK",
    lastActiveAt: "2026-08-01T00:00:00.000Z",
    publicBaseUrl: "https://storage.customer.example.com",
  };

  function twoLaneEnv(active: FakeR2Bucket, fallback: FakeR2Bucket) {
    return {
      UPLOADS_DEFAULT: active,
      UPLOADS_FALLBACK: fallback,
      WEB_ORIGIN: "https://uploads.sh",
    } as unknown as Env;
  }

  it("single-lane record keeps today's shape (no envelope) — control", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/a.png", new Uint8Array([1]));
    await bucket.put("default/b.png", new Uint8Array([1]));
    const { items, cursor } = await listObjects(makeEnv(bucket), baseRecord, { limit: 100 });
    expect(items.map((i) => i.key)).toEqual(["a.png", "b.png"]);
    expect(cursor).toBeNull();
  });

  it("merges interleaved keys across lanes, active wins the duplicate, and paginates via the composite cursor", async () => {
    const active = new FakeR2Bucket();
    const fallback = new FakeR2Bucket();
    // Active: a, c, e (no prefix on either lane here — keeps the fixture's
    // raw keys identical to what listObjects reports).
    await active.put("a.png", new Uint8Array([1]));
    await active.put("c.png", new Uint8Array([1]));
    // Duplicate key "e.png" in both lanes — active's copy must win. Distinct
    // sizes make the winning copy distinguishable in the DTO (`size`).
    await active.put("e.png", new Uint8Array([1]));
    // Fallback: b, d, e
    await fallback.put("b.png", new Uint8Array([1]));
    await fallback.put("d.png", new Uint8Array([1]));
    await fallback.put("e.png", new Uint8Array([1, 2, 3, 4, 5]));

    const ws: WorkspaceRecord = {
      ...baseRecord,
      prefix: undefined,
      storageLaneId: "lane_active1",
      storageLanes: [FALLBACK_LANE],
    };
    const env = twoLaneEnv(active, fallback);

    const page1 = await listObjects(env, ws, { limit: 4 });
    expect(page1.items.map((i) => i.key)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(page1.cursor).not.toBeNull();

    const page2 = await listObjects(env, ws, { limit: 4, cursor: page1.cursor! });
    expect(page2.items.map((i) => i.key)).toEqual(["e.png"]);
    // Active's 1-byte copy won over fallback's 5-byte copy.
    expect(page2.items[0].size).toBe(1);
    expect(page2.cursor).toBeNull();
  });

  it("excludes a standby lane (no lastActiveAt) from the fan-out — behaves single-lane", async () => {
    const active = new FakeR2Bucket();
    await active.put("a.png", new Uint8Array([1]));
    const standby: StorageLane = { ...FALLBACK_LANE, lastActiveAt: undefined };
    const ws: WorkspaceRecord = { ...baseRecord, prefix: undefined, storageLanes: [standby] };
    const { items, cursor } = await listObjects(makeEnv(active), ws, { limit: 100 });
    expect(items.map((i) => i.key)).toEqual(["a.png"]);
    expect(cursor).toBeNull();
  });
});
