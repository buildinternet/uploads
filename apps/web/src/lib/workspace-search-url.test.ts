import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
  isValidMetaKey,
  isValidMetaValue,
  readSearchFilters,
} from "./workspace-search-url";

describe("isValidMetaKey", () => {
  it("accepts lowercase dotted keys", () => {
    expect(isValidMetaKey("gh.repo")).toBe(true);
    expect(isValidMetaKey("app")).toBe(true);
  });
  it("rejects uppercase, leading digit, and overly long keys", () => {
    expect(isValidMetaKey("BadKey")).toBe(false);
    expect(isValidMetaKey("1app")).toBe(false);
    expect(isValidMetaKey("a".repeat(65))).toBe(false);
  });
});

describe("isValidMetaValue", () => {
  it("accepts 1–512 printable ASCII", () => {
    expect(isValidMetaValue("buildinternet/uploads")).toBe(true);
  });
  it("rejects empty, over-long, and control chars", () => {
    expect(isValidMetaValue("")).toBe(false);
    expect(isValidMetaValue("x".repeat(513))).toBe(false);
    expect(isValidMetaValue("a\tb")).toBe(false);
  });
});

describe("readSearchFilters", () => {
  it("parses meta.* params, first-wins on duplicates, drops invalid", () => {
    expect(
      readSearchFilters("?ws=acme&meta.gh.repo=a/b&meta.app=web&meta.app=api&meta.BAD=x"),
    ).toEqual([
      { key: "gh.repo", value: "a/b" },
      { key: "app", value: "web" },
    ]);
  });
  it("returns empty when there are no meta params", () => {
    expect(readSearchFilters("?ws=acme&path=f/")).toEqual([]);
  });
  it("caps a hand-crafted deep link at 24 filters", () => {
    const params = Array.from({ length: 25 }, (_, i) => `meta.k${i}=v${i}`).join("&");
    expect(readSearchFilters(`?${params}`)).toHaveLength(24);
  });
});

describe("buildSearchQuery", () => {
  it("serializes filters to a query string", () => {
    expect(
      buildSearchQuery([
        { key: "gh.repo", value: "a/b" },
        { key: "app", value: "web" },
      ]),
    ).toBe("meta.gh.repo=a%2Fb&meta.app=web");
  });
});
