import { describe, expect, it } from "vitest";
import { isTallImage, resolvePreviewMode, TALL_ASPECT_RATIO } from "./image-preview-mode";

describe("isTallImage", () => {
  it("is false for empty or zero dimensions", () => {
    expect(isTallImage(0, 1000)).toBe(false);
    expect(isTallImage(800, 0)).toBe(false);
  });

  it("is false for landscape and roughly square images", () => {
    expect(isTallImage(1600, 900)).toBe(false);
    expect(isTallImage(1000, 1000)).toBe(false);
    expect(isTallImage(1000, 1349)).toBe(false);
  });

  it("is true at the tall aspect threshold", () => {
    expect(isTallImage(1000, 1350)).toBe(true);
    expect(isTallImage(800, 2000)).toBe(true);
  });

  it("respects a custom ratio", () => {
    expect(isTallImage(1000, 1500, 2)).toBe(false);
    expect(isTallImage(1000, 2000, 2)).toBe(true);
  });

  it("exports a stable default threshold", () => {
    expect(TALL_ASPECT_RATIO).toBe(1.35);
  });
});

describe("resolvePreviewMode", () => {
  it("prefers an explicit in-page override over aspect ratio", () => {
    expect(resolvePreviewMode({ override: "fit", naturalWidth: 800, naturalHeight: 2400 })).toBe(
      "fit",
    );
    expect(resolvePreviewMode({ override: "full", naturalWidth: 1600, naturalHeight: 900 })).toBe(
      "full",
    );
  });

  it("auto-selects full for tall images when nothing is overridden", () => {
    expect(resolvePreviewMode({ override: null, naturalWidth: 900, naturalHeight: 2200 })).toBe(
      "full",
    );
  });

  it("auto-selects fit for wide images when nothing is overridden", () => {
    expect(resolvePreviewMode({ override: null, naturalWidth: 1600, naturalHeight: 900 })).toBe(
      "fit",
    );
  });
});
