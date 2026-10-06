import { describe, expect, it } from "vitest";
import { buildUploadDrilldown, peakIndex } from "./admin-metrics-drilldown";

const rows = [
  { day: "2026-09-01", workspace: "beta", count: 1, bytes: 10 },
  { day: "2026-09-01", workspace: "acme", count: 3, bytes: 300 },
  { day: "2026-09-02", workspace: "beta", count: 5, bytes: 50 },
];

describe("buildUploadDrilldown", () => {
  const drill = buildUploadDrilldown(rows);

  it("groups by day, busiest first, with totals and each workspace's share", () => {
    expect(drill.byDay.get("2026-09-01")).toEqual({
      total: 4,
      contributors: [
        { workspace: "acme", count: 3, bytes: 300, share: 0.75 },
        { workspace: "beta", count: 1, bytes: 10, share: 0.25 },
      ],
    });
    expect(drill.byDay.get("2026-09-02")?.contributors.map((c) => c.workspace)).toEqual(["beta"]);
    expect(drill.byDay.has("2026-09-03")).toBe(false);
  });

  it("orders workspaces by total uploads across the window", () => {
    expect(drill.workspaces).toEqual(["beta", "acme"]);
  });

  it("keeps each workspace's own daily points", () => {
    expect(drill.byWorkspace.get("acme")).toEqual([{ day: "2026-09-01", value: 3 }]);
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
