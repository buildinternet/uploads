import { describe, expect, it } from "vitest";
import {
  applyUsageDelta,
  emptyUsage,
  getWorkspaceUsage,
  releaseStorageBytesSafe,
  releaseUploadsSafe,
  reserveStorageBytes,
  reserveUploads,
  usagePeriodStart,
} from "../src/usage";
import { UsageFakeD1 } from "./usage-fake-d1";

describe("usagePeriodStart", () => {
  it("formats UTC calendar month as YYYY-MM", () => {
    expect(usagePeriodStart(new Date("2026-07-10T12:00:00Z"))).toBe("2026-07");
  });
});

describe("workspace usage ledger", () => {
  it("returns empty usage when no row exists", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const now = new Date("2026-07-10T00:00:00Z");
    expect(await getWorkspaceUsage(db, "acme", now)).toEqual(emptyUsage("acme", now));
  });

  it("increments on put and decrements on delete", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const now = new Date("2026-07-10T00:00:00Z");

    await applyUsageDelta(db, "acme", { bytes: 1200, objects: 1, uploads: 1 }, now);
    await applyUsageDelta(db, "acme", { bytes: 800, objects: 1, uploads: 1 }, now);
    let snap = await getWorkspaceUsage(db, "acme", now);
    expect(snap).toMatchObject({ bytes: 2000, objects: 2, uploadsInPeriod: 2 });

    await applyUsageDelta(db, "acme", { bytes: -1200, objects: -1, uploads: 0 }, now);
    snap = await getWorkspaceUsage(db, "acme", now);
    expect(snap).toMatchObject({ bytes: 800, objects: 1, uploadsInPeriod: 2 });
  });

  it("adjusts net bytes on overwrite (delta only)", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const now = new Date("2026-07-10T00:00:00Z");
    await applyUsageDelta(db, "acme", { bytes: 1000, objects: 1, uploads: 1 }, now);
    await applyUsageDelta(db, "acme", { bytes: -400, objects: 0, uploads: 1 }, now);
    expect(await getWorkspaceUsage(db, "acme", now)).toMatchObject({
      bytes: 600,
      objects: 1,
      uploadsInPeriod: 2,
    });
  });

  it("resets uploads_in_period on a new calendar month", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    await applyUsageDelta(
      db,
      "acme",
      { bytes: 100, objects: 1, uploads: 5 },
      new Date("2026-07-10T00:00:00Z"),
    );
    expect(await getWorkspaceUsage(db, "acme", new Date("2026-08-01T00:00:00Z"))).toMatchObject({
      bytes: 100,
      uploadsInPeriod: 0,
      periodStart: "2026-08",
    });

    await applyUsageDelta(
      db,
      "acme",
      { bytes: 50, objects: 1, uploads: 1 },
      new Date("2026-08-02T00:00:00Z"),
    );
    expect(await getWorkspaceUsage(db, "acme", new Date("2026-08-02T00:00:00Z"))).toMatchObject({
      bytes: 150,
      uploadsInPeriod: 1,
      periodStart: "2026-08",
    });
  });

  it("isolates workspaces and clamps at zero", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const now = new Date("2026-07-10T00:00:00Z");
    await applyUsageDelta(db, "acme", { bytes: 100, objects: 1, uploads: 1 }, now);
    await applyUsageDelta(db, "globex", { bytes: 999, objects: 3, uploads: 2 }, now);
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(100);
    expect((await getWorkspaceUsage(db, "globex", now)).bytes).toBe(999);

    await applyUsageDelta(db, "acme", { bytes: -999, objects: -5, uploads: 0 }, now);
    expect(await getWorkspaceUsage(db, "acme", now)).toMatchObject({ bytes: 0, objects: 0 });
  });
});

describe("upload reservations", () => {
  const now = new Date("2026-07-10T00:00:00Z");

  it("reserves up to the cap, then denies with a usage snapshot", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    expect((await reserveUploads(db, "acme", 1, 2, now)).ok).toBe(true);
    expect((await reserveUploads(db, "acme", 1, 2, now)).ok).toBe(true);

    const denied = await reserveUploads(db, "acme", 1, 2, now);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.usage.uploadsInPeriod).toBe(2);
      expect(denied.maxUploadsPerPeriod).toBe(2);
    }
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(2);
  });

  it("counts uploads at reservation time when unlimited", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    expect((await reserveUploads(db, "acme", 1, undefined, now)).ok).toBe(true);
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(1);
  });

  it("treats a rolled-over period as zero uploads", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    await applyUsageDelta(db, "acme", { bytes: 0, objects: 0, uploads: 2 }, now);

    const august = new Date("2026-08-01T00:00:00Z");
    const res = await reserveUploads(db, "acme", 1, 2, august);
    expect(res.ok).toBe(true);
    expect(await getWorkspaceUsage(db, "acme", august)).toMatchObject({
      uploadsInPeriod: 1,
      periodStart: "2026-08",
    });
  });

  it("release returns a same-period reservation, clamped at zero", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    await reserveUploads(db, "acme", 1, 2, now);
    await releaseUploadsSafe(db, "acme", 1, now);
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(0);

    // Over-release never goes negative.
    await releaseUploadsSafe(db, "acme", 1, now);
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(0);
  });

  it("release after a period rollover is a no-op", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    await reserveUploads(db, "acme", 1, 2, now);

    await releaseUploadsSafe(db, "acme", 1, new Date("2026-08-01T00:00:00Z"));
    // The stored row still holds July's count untouched.
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(1);
  });

  it("only admits the cap under concurrent reservations", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveUploads(db, "acme", 1, 2, now)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect((await getWorkspaceUsage(db, "acme", now)).uploadsInPeriod).toBe(2);
  });
});

describe("storage byte reservations", () => {
  const now = new Date("2026-07-10T00:00:00Z");

  it("reserves positive deltas up to the storage cap, then denies", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const a = await reserveStorageBytes(db, "acme", 600, 1000, now);
    expect(a).toEqual({ ok: true, reservedBytes: 600 });
    const b = await reserveStorageBytes(db, "acme", 400, 1000, now);
    expect(b).toEqual({ ok: true, reservedBytes: 400 });

    const denied = await reserveStorageBytes(db, "acme", 1, 1000, now);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.usage.bytes).toBe(1000);
      expect(denied.maxStorageBytes).toBe(1000);
      expect(denied.deltaBytes).toBe(1);
    }
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(1000);
  });

  it("no-ops for non-positive deltas and unlimited workspaces", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    expect(await reserveStorageBytes(db, "acme", 0, 1000, now)).toEqual({
      ok: true,
      reservedBytes: 0,
    });
    expect(await reserveStorageBytes(db, "acme", -50, 1000, now)).toEqual({
      ok: true,
      reservedBytes: 0,
    });
    expect(await reserveStorageBytes(db, "acme", 500, undefined, now)).toEqual({
      ok: true,
      reservedBytes: 0,
    });
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(0);
  });

  it("release returns reserved bytes, clamped at zero", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    await reserveStorageBytes(db, "acme", 200, 1000, now);
    await releaseStorageBytesSafe(db, "acme", 200, now);
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(0);
    await releaseStorageBytesSafe(db, "acme", 50, now);
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(0);
  });

  it("only admits the storage cap under concurrent reservations", async () => {
    const db = new UsageFakeD1() as unknown as D1Database;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveStorageBytes(db, "acme", 400, 1000, now)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect((await getWorkspaceUsage(db, "acme", now)).bytes).toBe(800);
  });
});
