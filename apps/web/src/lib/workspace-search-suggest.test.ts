import { describe, expect, it } from "vitest";
import {
  buildSuggestions,
  clampActiveIndex,
  firstSelectableIndex,
  isSelectableSuggestion,
  parseDraft,
  stepActiveIndex,
  type Suggestion,
} from "./workspace-search-suggest";

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

  // Review finding: filename search disappeared exactly where it mattered
  // most, because the facets-state early returns fired before the bare-text
  // `name` row was ever produced. These four cases pin the fixed behaviour.
  it("offers name search alongside the hint while facets are still loading", () => {
    const out = buildSuggestions({
      draft: "hero",
      facets: null,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "name", term: "hero" }, { kind: "hint" }]);
  });

  it("shows only the hint while facets are loading and the draft is empty", () => {
    const out = buildSuggestions({
      draft: "",
      facets: null,
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "hint" }]);
  });

  it("offers name search alongside empty-facets when the workspace has no metadata", () => {
    const out = buildSuggestions({
      draft: "hero",
      facets: [],
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "name", term: "hero" }, { kind: "empty-facets" }]);
  });

  it("shows only empty-facets when the workspace has no metadata and the draft is empty", () => {
    const out = buildSuggestions({
      draft: "",
      facets: [],
      values: null,
      selectedKey: null,
      activeKeys: [],
    });
    expect(out).toEqual([{ kind: "empty-facets" }]);
  });

  it("appends the truncated row after the key list when the key list was capped", () => {
    const out = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
      keysTruncated: true,
    });
    expect(out[out.length - 1]).toEqual({ kind: "truncated" });
  });

  it("appends the truncated row after the value list when the value list was capped", () => {
    const out = buildSuggestions({
      draft: "app=",
      facets: FACETS,
      values: [{ value: "web", count: 40 }],
      selectedKey: "app",
      activeKeys: [],
      valuesTruncated: true,
    });
    expect(out).toEqual([
      { kind: "value", key: "app", value: "web", count: 40 },
      { kind: "truncated" },
    ]);
  });

  it("does not show the truncated row when nothing was capped", () => {
    const keyList = buildSuggestions({
      draft: "",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
      keysTruncated: false,
    });
    expect(keyList.some((s) => s.kind === "truncated")).toBe(false);

    const valueList = buildSuggestions({
      draft: "app=",
      facets: FACETS,
      values: [{ value: "web", count: 40 }],
      selectedKey: "app",
      activeKeys: [],
      valuesTruncated: false,
    });
    expect(valueList.some((s) => s.kind === "truncated")).toBe(false);
  });

  it("the truncated row is not selectable", () => {
    expect(isSelectableSuggestion({ kind: "truncated" })).toBe(false);
  });

  it("the truncated row sits at the very end even with the bare-text name+key list", () => {
    const out = buildSuggestions({
      draft: "gh",
      facets: FACETS,
      values: null,
      selectedKey: null,
      activeKeys: [],
      keysTruncated: true,
    });
    expect(out[out.length - 1]).toEqual({ kind: "truncated" });
  });
});

describe("isSelectableSuggestion", () => {
  it("treats name/key/value rows as selectable", () => {
    expect(isSelectableSuggestion({ kind: "name", term: "x" })).toBe(true);
    expect(isSelectableSuggestion({ kind: "key", key: "app", count: 1, distinctValues: 1 })).toBe(
      true,
    );
    expect(isSelectableSuggestion({ kind: "value", key: "app", value: "web", count: 1 })).toBe(
      true,
    );
  });

  it("treats hint/loading/empty-facets rows as non-selectable", () => {
    expect(isSelectableSuggestion({ kind: "hint" })).toBe(false);
    expect(isSelectableSuggestion({ kind: "loading" })).toBe(false);
    expect(isSelectableSuggestion({ kind: "empty-facets" })).toBe(false);
  });
});

describe("firstSelectableIndex / clampActiveIndex / stepActiveIndex", () => {
  const mixed: Suggestion[] = [
    { kind: "hint" },
    { kind: "key", key: "app", count: 1, distinctValues: 1 },
    { kind: "key", key: "gh.repo", count: 1, distinctValues: 1 },
  ];
  const noneSelectable: Suggestion[] = [{ kind: "loading" }];

  it("finds the first selectable row, skipping leading hints", () => {
    expect(firstSelectableIndex(mixed)).toBe(1);
  });

  it("returns -1 when nothing is selectable", () => {
    expect(firstSelectableIndex(noneSelectable)).toBe(-1);
    expect(clampActiveIndex(noneSelectable, 0)).toBe(-1);
    expect(stepActiveIndex(noneSelectable, 0, 1)).toBe(-1);
  });

  it("clamp keeps an already-selectable index as-is", () => {
    expect(clampActiveIndex(mixed, 2)).toBe(2);
  });

  it("clamp redirects a non-selectable or out-of-range index to the first selectable row", () => {
    expect(clampActiveIndex(mixed, 0)).toBe(1);
    expect(clampActiveIndex(mixed, 99)).toBe(1);
    expect(clampActiveIndex(mixed, -1)).toBe(1);
  });

  it("step moves forward/backward across selectable rows only", () => {
    expect(stepActiveIndex(mixed, 1, 1)).toBe(2);
    expect(stepActiveIndex(mixed, 2, 1)).toBe(2); // clamps at the end
    expect(stepActiveIndex(mixed, 2, -1)).toBe(1);
    expect(stepActiveIndex(mixed, 1, -1)).toBe(1); // clamps at the start
  });

  it("step from a non-selectable current index snaps to an end based on direction", () => {
    expect(stepActiveIndex(mixed, 0, 1)).toBe(1);
    expect(stepActiveIndex(mixed, 0, -1)).toBe(2);
  });
});
