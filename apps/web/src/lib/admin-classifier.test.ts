import { describe, expect, it } from "vitest";
import {
  coverageLabel,
  estimatedCost,
  formatUsd,
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

describe("formatUsd", () => {
  it("keeps fractions of a cent readable", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0.01234)).toBe("$0.0123");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});

describe("estimatedCost", () => {
  it("scales cost per input token to calls that carried no cost", () => {
    const estimate = estimatedCost([
      { calls: 4, inputTokens: 4000, pricedInputTokens: 2000, cost: 0.02 },
      { calls: 0, inputTokens: 0, pricedInputTokens: 0, cost: 0 },
    ]);
    expect(estimate?.cost).toBeCloseTo(0.04);
    expect(estimate).toMatchObject({ calls: 4, inputTokens: 4000 });
  });

  it("falls back to the reported cost without token counts", () => {
    expect(estimatedCost([{ calls: 2, inputTokens: 0, pricedInputTokens: 0, cost: 0.01 }])).toEqual(
      { cost: 0.01, calls: 2, inputTokens: 0 },
    );
  });

  it("is null when no call reported a cost", () => {
    expect(
      estimatedCost([{ calls: 3, inputTokens: 900, pricedInputTokens: 0, cost: 0 }]),
    ).toBeNull();
    expect(estimatedCost([])).toBeNull();
  });
});
