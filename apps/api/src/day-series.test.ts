import { describe, expect, it } from "vitest";
import { fillDaySeries, normalizeUtcDay, utcDaysInWindow } from "./day-series";

describe("normalizeUtcDay", () => {
  it("keeps a bare YYYY-MM-DD", () => {
    expect(normalizeUtcDay("2026-09-17")).toBe("2026-09-17");
  });

  it("strips a trailing time from an Analytics Engine datetime", () => {
    expect(normalizeUtcDay("2026-09-17 00:00:00")).toBe("2026-09-17");
  });

  it("rejects non-dates", () => {
    expect(normalizeUtcDay("Sep 17")).toBeNull();
    expect(normalizeUtcDay(null)).toBeNull();
    expect(normalizeUtcDay(17)).toBeNull();
  });
});

describe("utcDaysInWindow", () => {
  it("returns every inclusive UTC day in the window", () => {
    expect(utcDaysInWindow("2026-09-01", 3)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("crosses a month boundary", () => {
    expect(utcDaysInWindow("2026-08-30", 4)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("treats a 1-day window as since only", () => {
    expect(utcDaysInWindow("2026-09-17", 1)).toEqual(["2026-09-17"]);
  });

  it("returns nothing for an invalid since", () => {
    expect(utcDaysInWindow("not-a-date", 7)).toEqual([]);
  });
});

describe("fillDaySeries", () => {
  it("inserts zeros on days with no activity and keeps real counts", () => {
    const filled = fillDaySeries(
      "2026-09-01",
      4,
      [
        { day: "2026-09-01", count: 3 },
        { day: "2026-09-03", count: 1 },
      ],
      (day) => ({ day, count: 0 }),
    );
    expect(filled).toEqual([
      { day: "2026-09-01", count: 3 },
      { day: "2026-09-02", count: 0 },
      { day: "2026-09-03", count: 1 },
      { day: "2026-09-04", count: 0 },
    ]);
  });

  it("drops points outside the window", () => {
    const filled = fillDaySeries(
      "2026-09-02",
      2,
      [
        { day: "2026-09-01", count: 9 },
        { day: "2026-09-02", count: 2 },
      ],
      (day) => ({ day, count: 0 }),
    );
    expect(filled).toEqual([
      { day: "2026-09-02", count: 2 },
      { day: "2026-09-03", count: 0 },
    ]);
  });
});
