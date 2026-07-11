import { describe, expect, it } from "vitest";
import { applyUsageDelta, emptyUsage, getWorkspaceUsage, usagePeriodStart } from "../src/usage";
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
