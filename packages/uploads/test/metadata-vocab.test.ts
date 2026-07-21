import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import {
  formatViewport,
  mergeDerivedMeta,
  nearMissMetaWarnings,
  validateStateValue,
} from "../src/metadata-vocab.js";

describe("validateStateValue", () => {
  it("accepts every canonical value", () => {
    for (const v of ["before", "after", "empty", "error", "loading"]) {
      expect(validateStateValue(v)).toBe(v);
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(validateStateValue("  After ")).toBe("after");
  });

  it("suggests the canonical value for a known near-miss", () => {
    expect(() => validateStateValue("pre")).toThrow(/did you mean "before"/);
    expect(() => validateStateValue("post")).toThrow(/did you mean "after"/);
  });

  it("lists the valid values for an unknown value", () => {
    expect(() => validateStateValue("banana")).toThrow(UsageError);
    expect(() => validateStateValue("banana")).toThrow(/before, after, empty, error, loading/);
  });
});

describe("nearMissMetaWarnings", () => {
  it("warns for a known alias", () => {
    expect(nearMissMetaWarnings(["route"])).toEqual([
      'metadata key "route" is not canonical — did you mean "path"?',
    ]);
  });

  it("is silent for canonical keys", () => {
    expect(nearMissMetaWarnings(["path", "state", "gh.repo"])).toEqual([]);
  });

  it("is silent for unrecognized custom keys", () => {
    expect(nearMissMetaWarnings(["commit", "ticket"])).toEqual([]);
  });
});

describe("formatViewport", () => {
  it("renders an integer scale without a decimal", () => {
    expect(formatViewport(1280, 800, 2)).toBe("1280x800@2x");
  });

  it("keeps a fractional scale", () => {
    expect(formatViewport(812, 577, 1.5)).toBe("812x577@1.5x");
  });
});

describe("mergeDerivedMeta", () => {
  it("lets an explicit key win over a derived one", () => {
    expect(mergeDerivedMeta({ path: "/mine" }, { path: "/derived", app: "web" })).toEqual({
      path: "/mine",
      app: "web",
    });
  });

  it("drops derived keys rather than exceeding the 24-key cap", () => {
    const explicit: Record<string, string> = {};
    for (let i = 0; i < 24; i++) explicit[`k${i}`] = "v";
    const merged = mergeDerivedMeta(explicit, { path: "/settings" });
    expect(merged).toEqual(explicit);
    expect(merged.path).toBeUndefined();
  });

  it("never throws when the explicit map is already at the cap", () => {
    const explicit: Record<string, string> = {};
    for (let i = 0; i < 24; i++) explicit[`k${i}`] = "v";
    expect(() => mergeDerivedMeta(explicit, { path: "/a", app: "web" })).not.toThrow();
  });
});
