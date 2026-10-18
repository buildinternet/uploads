import { describe, expect, it } from "vitest";
import { resolvePreviewMode } from "./image-preview-mode";

describe("resolvePreviewMode", () => {
  it.each([null, "", "invalid", "fit"])("uses fit for the saved value %s", (saved) => {
    expect(resolvePreviewMode(saved)).toBe("fit");
  });

  it("restores an explicit full-width choice", () => {
    expect(resolvePreviewMode("full")).toBe("full");
  });
});
