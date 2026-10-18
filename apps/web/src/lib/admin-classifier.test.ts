import { describe, expect, it } from "vitest";
import {
  coverageLabel,
  flagLabel,
  flaggedFileHref,
  flagVariant,
  sharePercent,
  topFlaggedValues,
  withShares,
} from "./admin-classifier";

describe("sharePercent", () => {
  it("handles zero totals and small shares", () => {
    expect(sharePercent(5, 0)).toBe("0%");
    expect(sharePercent(0, 10)).toBe("0%");
    expect(sharePercent(1, 10000)).toBe("<0.1%");
    expect(sharePercent(1, 40)).toBe("2.5%");
    expect(sharePercent(1, 3)).toBe("33%");
  });
});

describe("withShares", () => {
  it("adds shares against the table total", () => {
    expect(
      withShares([
        { value: "v6", count: 3 },
        { value: "skipped", count: 1 },
      ]).map((r) => r.share),
    ).toEqual(["75%", "25%"]);
  });
});

describe("coverageLabel", () => {
  it("is null without a platform count", () => {
    expect(coverageLabel([{ classified: 5 }], null)).toBeNull();
    expect(coverageLabel([{ classified: 5 }], 0)).toBeNull();
  });
  it("divides classified-in-window by window uploads", () => {
    expect(coverageLabel([{ classified: 5 }, { classified: 5 }], 40)).toBe("25%");
  });
});

describe("topFlaggedValues", () => {
  it("drops the clean value and zero counts", () => {
    expect(
      topFlaggedValues(
        [
          { value: "safe", count: 90 },
          { value: "adult", count: 4 },
          { value: "violent", count: 0 },
          { value: "other", count: 2 },
        ],
        "safe",
        2,
      ),
    ).toEqual([
      { value: "adult", count: 4 },
      { value: "other", count: 2 },
    ]);
  });
});

describe("flags", () => {
  it("labels and styles by confidence", () => {
    expect(flagLabel({ field: "pii", value: "email" })).toBe("pii: email");
    expect(flagVariant("high")).toBe("destructive");
    expect(flagVariant("medium")).toBe("secondary");
    expect(flagVariant("low")).toBe("outline");
    expect(flagVariant(null)).toBe("outline");
  });
});

describe("flaggedFileHref", () => {
  it("encodes segments and keeps slashes", () => {
    expect(flaggedFileHref({ workspace: "acme", key: "a b/c#d.png" })).toBe(
      "/f/acme/a%20b/c%23d.png",
    );
  });
});
