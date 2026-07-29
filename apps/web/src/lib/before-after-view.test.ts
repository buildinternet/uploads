import { describe, expect, it } from "vitest";
import { comparisonRows, compareImages, ownBeforeAfterState } from "./before-after-view";

describe("ownBeforeAfterState", () => {
  it("trusts this file's own state metadata when it is valid", () => {
    expect(ownBeforeAfterState("before", "after")).toBe("before");
    expect(ownBeforeAfterState("after", "before")).toBe("after");
  });

  it("falls back to the counterpart's opposite when metadata is missing", () => {
    expect(ownBeforeAfterState(undefined, "after")).toBe("before");
    expect(ownBeforeAfterState(undefined, "before")).toBe("after");
  });

  it("ignores junk metadata rather than trusting it", () => {
    expect(ownBeforeAfterState("sideways", "before")).toBe("after");
    expect(ownBeforeAfterState("", "after")).toBe("before");
  });

  // The API pairs on `state` metadata, so both sides claiming the same role is
  // not supposed to happen — but the page must still render a stable order.
  it("keeps its own claim even when both sides claim the same role", () => {
    expect(ownBeforeAfterState("after", "after")).toBe("after");
  });
});

describe("compareImages", () => {
  it("puts the before image first when this file is the after", () => {
    expect(compareImages("after", "own.png", "other.png")).toEqual({
      beforeUrl: "other.png",
      afterUrl: "own.png",
    });
  });

  it("puts this file first when it is the before", () => {
    expect(compareImages("before", "own.png", "other.png")).toEqual({
      beforeUrl: "own.png",
      afterUrl: "other.png",
    });
  });
});

describe("comparisonRows", () => {
  it("always orders before then after, regardless of which one this is", () => {
    expect(comparisonRows("after", "/f/ws/before.png").map((r) => r.state)).toEqual([
      "before",
      "after",
    ]);
    expect(comparisonRows("before", "/f/ws/after.png").map((r) => r.state)).toEqual([
      "before",
      "after",
    ]);
  });

  it("links only the counterpart row and marks the current one", () => {
    const rows = comparisonRows("after", "/f/ws/before.png");
    expect(rows).toEqual([
      { state: "before", current: false, href: "/f/ws/before.png" },
      { state: "after", current: true, href: null },
    ]);
  });
});
