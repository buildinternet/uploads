import { describe, expect, it } from "vitest";
import {
  buildSearchQuery,
  isValidMetaKey,
  isValidMetaValue,
  isValidSearchName,
  readSearchFilters,
  readSearchName,
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

  it("includes a valid name term alongside meta.* params", () => {
    expect(buildSearchQuery([{ key: "app", value: "web" }], "screenshot")).toBe(
      "name=screenshot&meta.app=web",
    );
  });

  it("drops an invalid name term", () => {
    expect(buildSearchQuery([{ key: "app", value: "web" }], "   ")).toBe("meta.app=web");
    expect(buildSearchQuery([], "x".repeat(129))).toBe("");
  });
});

describe("isValidSearchName", () => {
  it("accepts a 1–128 char term", () => {
    expect(isValidSearchName("screenshot")).toBe(true);
    expect(isValidSearchName("x".repeat(128))).toBe(true);
  });
  it("rejects empty, whitespace-only, and over-long terms", () => {
    expect(isValidSearchName("")).toBe(false);
    expect(isValidSearchName("   ")).toBe(false);
    expect(isValidSearchName("x".repeat(129))).toBe(false);
  });
});

describe("readSearchName", () => {
  it("reads a valid name param", () => {
    expect(readSearchName("?name=screenshot&meta.app=web")).toBe("screenshot");
  });
  it("returns undefined when there is no name param", () => {
    expect(readSearchName("?meta.app=web")).toBeUndefined();
  });
  it("ignores an empty or whitespace-only name param", () => {
    expect(readSearchName("?name=")).toBeUndefined();
    expect(readSearchName("?name=%20%20")).toBeUndefined();
  });
  it("ignores a name param over the 128-char cap", () => {
    expect(readSearchName(`?name=${"x".repeat(129)}`)).toBeUndefined();
  });
  it("round-trips a name term alongside meta.* params", () => {
    const query = buildSearchQuery([{ key: "gh.repo", value: "a/b" }], "screenshot");
    expect(readSearchName(`?${query}`)).toBe("screenshot");
    expect(readSearchFilters(`?${query}`)).toEqual([{ key: "gh.repo", value: "a/b" }]);
  });
});
