import { describe, expect, it } from "vitest";
import {
  contributorsByDay,
  peakIndex,
  workspaceDayPoints,
  workspacesByVolume,
} from "./admin-metrics-drilldown";

const rows = [
  { day: "2026-09-01", workspace: "beta", count: 1, bytes: 10 },
  { day: "2026-09-01", workspace: "acme", count: 3, bytes: 300 },
  { day: "2026-09-02", workspace: "beta", count: 5, bytes: 50 },
];

describe("contributorsByDay", () => {
  it("groups by day, busiest first, with each workspace's share", () => {
    const byDay = contributorsByDay(rows);
    expect(byDay.get("2026-09-01")).toEqual([
      { workspace: "acme", count: 3, bytes: 300, share: 0.75 },
      { workspace: "beta", count: 1, bytes: 10, share: 0.25 },
    ]);
    expect(byDay.get("2026-09-02")?.map((c) => c.workspace)).toEqual(["beta"]);
    expect(byDay.has("2026-09-03")).toBe(false);
  });
});

describe("workspacesByVolume", () => {
  it("orders by total uploads across the window", () => {
    expect(workspacesByVolume(rows)).toEqual(["beta", "acme"]);
  });
});

describe("workspaceDayPoints", () => {
  it("returns only the chosen workspace's days", () => {
    expect(workspaceDayPoints(rows, "acme")).toEqual([{ day: "2026-09-01", value: 3 }]);
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
