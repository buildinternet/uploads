import { describe, expect, it } from "vitest";
import { objectVisibility, sanitizeVisibility, VISIBILITY_META_KEY } from "../src/visibility";

describe("sanitizeVisibility", () => {
  it("passes through exactly 'private'", () => {
    expect(sanitizeVisibility("private")).toBe("private");
  });

  it("collapses anything else to undefined (public)", () => {
    expect(sanitizeVisibility("public")).toBeUndefined();
    expect(sanitizeVisibility("Private")).toBeUndefined();
    expect(sanitizeVisibility("")).toBeUndefined();
    expect(sanitizeVisibility(undefined)).toBeUndefined();
    expect(sanitizeVisibility(null)).toBeUndefined();
  });
});

describe("objectVisibility", () => {
  it("reads the visibility key off stored metadata", () => {
    expect(objectVisibility({ [VISIBILITY_META_KEY]: "private" })).toBe("private");
  });

  it("is public (undefined) when the key is absent or bogus", () => {
    expect(objectVisibility({})).toBeUndefined();
    expect(objectVisibility(undefined)).toBeUndefined();
    expect(objectVisibility({ [VISIBILITY_META_KEY]: "nope" })).toBeUndefined();
  });
});
