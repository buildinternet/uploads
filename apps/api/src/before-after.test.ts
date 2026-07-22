import { describe, expect, it } from "vitest";
import { attachmentPrefix, swapBeforeAfterToken } from "./before-after";

describe("attachmentPrefix", () => {
  it("returns everything up to and including the last slash", () => {
    expect(attachmentPrefix("gh/acme/web/pull/12/hero-before.webp")).toBe("gh/acme/web/pull/12/");
  });

  it("returns empty string for a root-level key", () => {
    expect(attachmentPrefix("hero-before.webp")).toBe("");
  });
});

describe("swapBeforeAfterToken", () => {
  it("swaps a lowercase -before- token to -after-", () => {
    expect(swapBeforeAfterToken("hero-before.webp")).toEqual({
      filename: "hero-after.webp",
      state: "before",
    });
  });

  it("swaps a lowercase -after- token to -before-", () => {
    expect(swapBeforeAfterToken("hero-after.webp")).toEqual({
      filename: "hero-before.webp",
      state: "after",
    });
  });

  it("preserves capitalized case style", () => {
    expect(swapBeforeAfterToken("Hero-Before.webp")).toEqual({
      filename: "Hero-After.webp",
      state: "before",
    });
  });

  it("preserves all-caps case style", () => {
    expect(swapBeforeAfterToken("HERO-BEFORE.webp")).toEqual({
      filename: "HERO-AFTER.webp",
      state: "before",
    });
  });

  it("matches an underscore-delimited token", () => {
    expect(swapBeforeAfterToken("hero_before.webp")).toEqual({
      filename: "hero_after.webp",
      state: "before",
    });
  });

  it("matches a token at the start of the filename", () => {
    expect(swapBeforeAfterToken("before-hero.webp")).toEqual({
      filename: "after-hero.webp",
      state: "before",
    });
  });

  it("does not match a substring like 'beforehand'", () => {
    expect(swapBeforeAfterToken("beforehand.webp")).toBeNull();
  });

  it("returns null when there is no before/after token at all", () => {
    expect(swapBeforeAfterToken("hero.webp")).toBeNull();
  });
});
