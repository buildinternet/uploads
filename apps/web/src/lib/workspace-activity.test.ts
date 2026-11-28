import { describe, expect, it } from "vitest";
import {
  changeLabel,
  parseActivityWindow,
  renderActivityBodyHtml,
  windowTotal,
  type ActivityDay,
} from "./workspace-activity";

function series(values: number[]): ActivityDay[] {
  const start = Date.UTC(2026, 10, 1);
  return values.map((uploads, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    uploads,
    prs: 0,
    comments: 0,
  }));
}

describe("windowTotal", () => {
  it("sums the window and the period before it", () => {
    const days = series([1, 1, 1, 2, 2, 2]);
    expect(windowTotal(days, "uploads", 3)).toEqual({ current: 6, previous: 3 });
  });

  it("has no baseline when the series is shorter than two windows", () => {
    expect(windowTotal(series([1, 2, 3]), "uploads", 3)).toEqual({ current: 6, previous: null });
  });
});

describe("changeLabel", () => {
  it("formats rises, falls and flat periods", () => {
    expect(changeLabel({ current: 1500, previous: 1000 }, 30)).toBe("+50% vs prior 30 days");
    expect(changeLabel({ current: 5, previous: 10 }, 7)).toBe("−50% vs prior 7 days");
    expect(changeLabel({ current: 4, previous: 4 }, 7)).toBe("Same as prior 7 days");
    expect(changeLabel({ current: 4, previous: 0 }, 7)).toBe("Up from 0 the prior 7 days");
  });

  it("stays empty without a baseline or any activity", () => {
    expect(changeLabel({ current: 4, previous: null }, 7)).toBe("");
    expect(changeLabel({ current: 0, previous: 0 }, 7)).toBe("");
  });
});

describe("parseActivityWindow", () => {
  it("accepts the three windows and falls back to 30", () => {
    expect(parseActivityWindow("7")).toBe(7);
    expect(parseActivityWindow("90")).toBe(90);
    expect(parseActivityWindow("365")).toBe(30);
  });
});

describe("renderActivityBodyHtml", () => {
  it("marks the selected tile and draws one bar per day in the window", () => {
    const days = series(Array.from({ length: 14 }, () => 1200));
    const html = renderActivityBodyHtml({ days }, 7, "uploads");
    expect(html).toContain('data-metric="uploads" aria-pressed="true"');
    expect(html).toContain('data-metric="prs" aria-pressed="false"');
    expect(html).toContain("8,400");
    expect(html.match(/class="metrics-bar"/g)).toHaveLength(7);
  });
});
