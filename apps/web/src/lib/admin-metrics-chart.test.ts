import { describe, expect, it } from "vitest";
import {
  buildYTicks,
  fillCountSeries,
  fillUploadClassSeries,
  formatAxisNumber,
  formatChartDay,
  niceCeil,
  pickLabelIndices,
  xLabelAnchor,
} from "./admin-metrics-chart";

describe("fillCountSeries", () => {
  it("inserts a 0 for every quiet day in the window", () => {
    expect(
      fillCountSeries("2026-09-01", 4, [
        { day: "2026-09-01", value: 3 },
        { day: "2026-09-03", value: 1 },
      ]),
    ).toEqual([
      { day: "2026-09-01", value: 3 },
      { day: "2026-09-02", value: 0 },
      { day: "2026-09-03", value: 1 },
      { day: "2026-09-04", value: 0 },
    ]);
  });

  it("keeps a 30-day window at 30 points even when the source is empty", () => {
    expect(fillCountSeries("2026-08-19", 30, [])).toHaveLength(30);
  });
});

describe("fillUploadClassSeries", () => {
  it("fills image/video/other zeros on quiet days", () => {
    expect(
      fillUploadClassSeries("2026-09-01", 2, [{ day: "2026-09-02", image: 4, video: 1, other: 0 }]),
    ).toEqual([
      { day: "2026-09-01", image: 0, video: 0, other: 0 },
      { day: "2026-09-02", image: 4, video: 1, other: 0 },
    ]);
  });
});

describe("niceCeil / buildYTicks", () => {
  it("rounds 8700 up to 10_000 with ticks at 0, 5k, 10k", () => {
    expect(niceCeil(8700)).toBe(10_000);
    expect(buildYTicks(10_000)).toEqual([0, 5_000, 10_000]);
  });

  it("drops a colliding midpoint when niceMax is 1", () => {
    expect(buildYTicks(1)).toEqual([0, 1]);
  });
});

describe("formatAxisNumber", () => {
  it("uses compact thousands so Y labels fit the gutter", () => {
    expect(formatAxisNumber(0)).toBe("0");
    expect(formatAxisNumber(5)).toBe("5");
    expect(formatAxisNumber(1000)).toBe("1k");
    expect(formatAxisNumber(5000)).toBe("5k");
    expect(formatAxisNumber(10_000)).toBe("10k");
    expect(formatAxisNumber(1_500_000)).toBe("1.5M");
  });
});

describe("formatChartDay", () => {
  it("formats a UTC day without shifting the calendar date", () => {
    expect(formatChartDay("2026-09-17")).toBe("Sep 17");
  });
});

describe("pickLabelIndices / xLabelAnchor", () => {
  it("labels every day on a 7-day window", () => {
    expect([...pickLabelIndices(7)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("always includes the first and last index on a 30-day window", () => {
    const idx = pickLabelIndices(30);
    expect(idx.has(0)).toBe(true);
    expect(idx.has(29)).toBe(true);
    expect(idx.size).toBeLessThanOrEqual(8);
  });

  it("anchors the first label left and the last label right", () => {
    expect(xLabelAnchor(0, 30)).toBe("start");
    expect(xLabelAnchor(29, 30)).toBe("end");
    expect(xLabelAnchor(10, 30)).toBe("middle");
  });
});
