import { describe, expect, it } from "vitest";
import {
  applyMediaFailure,
  imageLoadFailed,
  mediaPreviewFailedBody,
  MEDIA_PREVIEW_FAILED_TITLE,
} from "./media-load";

describe("imageLoadFailed", () => {
  it("is false while the image is still loading", () => {
    expect(imageLoadFailed({ complete: false, naturalWidth: 0 })).toBe(false);
  });

  it("is false for a decoded bitmap", () => {
    expect(imageLoadFailed({ complete: true, naturalWidth: 800 })).toBe(false);
  });

  it("is true when loading finished with no bitmap", () => {
    expect(imageLoadFailed({ complete: true, naturalWidth: 0 })).toBe(true);
  });
});

describe("mediaPreviewFailedBody", () => {
  it("names the media kind in the recovery copy", () => {
    expect(MEDIA_PREVIEW_FAILED_TITLE).toBe("Preview failed");
    expect(mediaPreviewFailedBody("image")).toMatch(/image/);
    expect(mediaPreviewFailedBody("video")).toMatch(/video/);
  });
});

describe("applyMediaFailure", () => {
  it("marks the root, unhides the fallback, and is idempotent", () => {
    const fallback = { hidden: true };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector: () => fallback,
    };
    const asRoot = root as unknown as HTMLElement;
    expect(applyMediaFailure(asRoot)).toBe(true);
    expect(root.dataset.failed).toBe("1");
    expect(fallback.hidden).toBe(false);
    expect(applyMediaFailure(asRoot)).toBe(false);
  });
});
