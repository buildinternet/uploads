import { describe, expect, it } from "vitest";
import { indexDaySummaries, peakIndex, withShares } from "./admin-metrics-drilldown";

describe("indexDaySummaries", () => {
  it("indexes by day and tolerates a missing summary", () => {
    const byDay = indexDaySummaries([
      { day: "2026-09-01", total: 4, workspaces: 2, top: [{ workspace: "acme", count: 3 }] },
    ]);
    expect(byDay.get("2026-09-01")?.top[0].workspace).toBe("acme");
    expect(byDay.has("2026-09-02")).toBe(false);
    expect(indexDaySummaries(undefined).size).toBe(0);
  });
});

describe("withShares", () => {
  it("adds each contributor's share of the day total, preserving order", () => {
    expect(
      withShares({
        day: "2026-09-01",
        total: 4,
        contributors: [
          { workspace: "acme", count: 3, bytes: 300 },
          { workspace: "beta", count: 1, bytes: 10 },
        ],
      }),
    ).toEqual([
      { workspace: "acme", count: 3, bytes: 300, share: 0.75 },
      { workspace: "beta", count: 1, bytes: 10, share: 0.25 },
    ]);
  });

  it("gives a zero share when the total is 0", () => {
    expect(
      withShares({ day: "d", total: 0, contributors: [{ workspace: "a", count: 0, bytes: 0 }] })[0]
        .share,
    ).toBe(0);
  });
});

describe("peakIndex", () => {
  it("picks the largest value, latest on a tie", () => {
    expect(peakIndex([1, 4, 2, 4])).toBe(3);
  });

  it("returns null when nothing happened", () => {
    expect(peakIndex([0, 0])).toBeNull();
    expect(peakIndex([])).toBeNull();
  });
});
