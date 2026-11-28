import { describe, expect, it } from "vitest";
import {
  changeLabel,
  parseActivityWindow,
  renderActivityBodyHtml,
  splitUploads,
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
    const html = renderActivityBodyHtml({ days, uploadTypes: false }, 7, "uploads");
    expect(html).toContain('data-metric="uploads" aria-pressed="true"');
    expect(html).toContain('data-metric="prs" aria-pressed="false"');
    expect(html).toContain("8,400");
    expect(html.match(/class="metrics-bar"/g)).toHaveLength(7);
  });
});

describe("splitUploads", () => {
  const day = { day: "2026-11-27", uploads: 10, prs: 0, comments: 0 };

  it("scales the sampled split to the upload count and always sums to it", () => {
    expect(splitUploads({ ...day, types: { image: 2, video: 1, other: 0 } })).toEqual({
      image: 7,
      video: 3,
      other: 0,
    });
    const odd = splitUploads({ ...day, uploads: 7, types: { image: 1, video: 1, other: 1 } })!;
    expect(odd.image + odd.video + odd.other).toBe(7);
  });

  it("returns null without a split, or when the split is empty but uploads are not", () => {
    expect(splitUploads(day)).toBeNull();
    expect(splitUploads({ ...day, types: { image: 0, video: 0, other: 0 } })).toBeNull();
  });
});

describe("stacked uploads chart", () => {
  it("stacks typed days and adds a legend only on the Uploads chart", () => {
    const days = series([4, 4]);
    for (const d of days) Object.assign(d, { prs: 1, types: { image: 3, video: 1, other: 0 } });
    const uploads = renderActivityBodyHtml({ days, uploadTypes: true }, 2, "uploads");
    expect(uploads).toContain("metrics-bar-fill--image");
    expect(uploads).toContain("metrics-legend");
    expect(uploads).toContain("3 images, 1 video, 0 other");
    const prs = renderActivityBodyHtml({ days, uploadTypes: true }, 2, "prs");
    expect(prs).not.toContain("metrics-legend");
  });
});
