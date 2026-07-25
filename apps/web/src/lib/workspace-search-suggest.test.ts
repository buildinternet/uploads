import { describe, expect, it } from "vitest";
import { buildSuggestions, parseDraft } from "./workspace-search-suggest";

// Already ordered count-desc, as the facets route returns them. `buildSuggestions`
// deliberately preserves input order rather than re-sorting — ordering is the
// API's job and is covered by Task 1's tests.
const FACETS = [
  { key: "path", count: 212, distinctValues: 212 },
  { key: "gh.repo", count: 84, distinctValues: 6 },
  { key: "app", count: 40, distinctValues: 3 },
];

describe("parseDraft", () => {
  it("splits a key=value draft", () => {
    expect(parseDraft("gh.repo=buildinternet/uploads")).toEqual({
      key: "gh.repo",
      value: "buildinternet/uploads",
    });
  });

  it("trims around the separator", () => {
    expect(parseDraft("  app = web  ")).toEqual({ key: "app", value: "web" });
  });

  it("returns null for bare text", () => {
    expect(parseDraft("hero.png")).toBeNull();
  });

  it("returns null when the key side is empty", () => {
    expect(parseDraft("=web")).toBeNull();
  });

  it("keeps '=' inside the value", () => {
    expect(parseDraft("q=a=b")).toEqual({ key: "q", value: "a=b" });
  });
});

describe("buildSuggestions", () => {
  it("lists every key with a syntax hint when the draft is empty", () => {
    const out = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([
      { kind: "key", key: "path", count: 212, distinctValues: 212 },
      { kind: "key", key: "gh.repo", count: 84, distinctValues: 6 },
      { kind: "key", key: "app", count: 40, distinctValues: 3 },
      { kind: "hint" },
    ]);
  });

  it("omits keys already used as a filter", () => {
    const out = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: ["path", "gh.repo"],
    });
    expect(out.filter((s) => s.kind === "key").map((s) => (s as { key: string }).key)).toEqual([
      "app",
    ]);
  });

  it("offers name search first for bare text, then matching keys", () => {
    const out = buildSuggestions({
      draft: "gh",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out[0]).toEqual({ kind: "name", term: "gh" });
    expect(out[1]).toEqual({ kind: "key", key: "gh.repo", count: 84, distinctValues: 6 });
  });

  it("lists a selected key's values, filtered by what follows the '='", () => {
    const out = buildSuggestions({
      draft: "app=w",
      facets: FACETS,
      values: [
        { value: "web", count: 40 },
        { value: "api", count: 12 },
      ],
      selectedKey: "app",
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "value", key: "app", value: "web", count: 40 }]);
  });

  it("shows the loading row when a selected key's values have not loaded yet", () => {
    const out = buildSuggestions({
      draft: "app=",
      facets: FACETS,
      values: null,
      selectedKey: "app",
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "loading" }]);
  });

  it("does not show the loading row once values load to genuinely none", () => {
    const out = buildSuggestions({
      draft: "app=",
      facets: FACETS,
      values: [],
      selectedKey: "app",
      activeKeys: [],
    });
    expect(out).toEqual([]);
  });

  it("shows the empty-facets row when the workspace has no metadata", () => {
    const out = buildSuggestions({
      draft: "",
      facets: [],
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "empty-facets" }]);
  });

  it("falls back to the hint alone when facets could not be loaded", () => {
    const out = buildSuggestions({
      draft: "",
      facets: null,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "hint" }]);
  });

  it("offers name search even when no key matches the text", () => {
    const out = buildSuggestions({
      draft: "hero.png",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "name", term: "hero.png" }]);
  });
});
