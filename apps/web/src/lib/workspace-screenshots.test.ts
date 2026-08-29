import { describe, expect, it } from "vitest";
import {
  filterCatalog,
  focusIsKeyboardDriven,
  formatShotCount,
  groupsFromCatalog,
  isRepoLabel,
  isScreenshotsNavState,
  lastUpdatedLabel,
  leafName,
  pairedShotKeys,
  pathQueryMatches,
  pathSuggestions,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsHistoryMode,
  screenshotsSearch,
  screenshotsSearchFromView,
  screenshotsViewHref,
  screenshotsViewsEqual,
  SHOT_COUNT_DISPLAY_CAP,
  type ScreenshotsView,
  shotKindFromKey,
  shotPreviewCaption,
  shotPreviewPosition,
} from "./workspace-screenshots";

describe("pairedShotKeys", () => {
  it("marks a tile paired only when the opposite state exists in the same collection", () => {
    const keys = pairedShotKeys([
      { key: "p/1/after-500.webp", state: "after" },
      { key: "p/1/before-500.webp", state: "before" },
      { key: "p/1/after-404.webp", state: "after" },
      { key: "p/1/plain.webp" },
    ]);
    expect(keys.has("p/1/after-500.webp")).toBe(true);
    expect(keys.has("p/1/before-500.webp")).toBe(true);
    // An after with no before still counts as paired at the collection level
    // only when a before exists SOMEWHERE in the collection — pairing is
    // stem-based so an unrelated before must not mark it.
    expect(keys.has("p/1/after-404.webp")).toBe(false);
    expect(keys.has("p/1/plain.webp")).toBe(false);
  });

  it("pairs by filename stem with the before/after token swapped", () => {
    const keys = pairedShotKeys([
      { key: "g/hero-after.png", state: "after" },
      { key: "g/hero-before.png", state: "before" },
      { key: "g/other-after.png", state: "after" },
    ]);
    expect(keys.has("g/hero-after.png")).toBe(true);
    expect(keys.has("g/hero-before.png")).toBe(true);
    expect(keys.has("g/other-after.png")).toBe(false);
  });

  it("falls back to lone-pair matching when stems don't carry the token", () => {
    // Exactly one before and one after with token-less names: still a pair.
    const keys = pairedShotKeys([
      { key: "g/old.png", state: "before" },
      { key: "g/new.png", state: "after" },
    ]);
    expect(keys.has("g/old.png")).toBe(true);
    expect(keys.has("g/new.png")).toBe(true);
    // Ambiguous (two afters, one before, no stems): no pairing claimed.
    const ambiguous = pairedShotKeys([
      { key: "g/a.png", state: "after" },
      { key: "g/b.png", state: "after" },
      { key: "g/c.png", state: "before" },
    ]);
    expect(ambiguous.size).toBe(0);
  });

  it("ignores non-before/after states and empty input", () => {
    expect(pairedShotKeys([]).size).toBe(0);
    expect(
      pairedShotKeys([
        { key: "a.png", state: "draft" },
        { key: "b.png", state: "final" },
      ]).size,
    ).toBe(0);
  });
});

describe("shotKindFromKey", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(shotKindFromKey("shots/hero.PNG")).toBe("image");
    expect(shotKindFromKey("a/b/c.webp")).toBe("image");
    expect(shotKindFromKey("demo.mp4")).toBe("video");
    expect(shotKindFromKey("notes.pdf")).toBe("other");
    expect(shotKindFromKey("no-extension")).toBe("other");
  });
});

describe("lastUpdatedLabel", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  it("scales from minutes to a date", () => {
    expect(lastUpdatedLabel("2026-08-10T11:59:40.000Z", now)).toBe("just now");
    expect(lastUpdatedLabel("2026-08-10T11:55:00.000Z", now)).toBe("5m ago");
    expect(lastUpdatedLabel("2026-08-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(lastUpdatedLabel("2026-08-06T12:00:00.000Z", now)).toBe("4d ago");
    expect(lastUpdatedLabel("2026-07-02T12:00:00.000Z", now)).toBe("Jul 2");
  });
  it("falls back to the raw string on an unparseable date", () => {
    expect(lastUpdatedLabel("garbage", now)).toBe("garbage");
  });
});

describe("formatShotCount", () => {
  it("pluralizes below the display cap", () => {
    expect(formatShotCount(0)).toBe("0 files");
    expect(formatShotCount(1)).toBe("1 file");
    expect(formatShotCount(12)).toBe("12 files");
    expect(formatShotCount(SHOT_COUNT_DISPLAY_CAP)).toBe("100 files");
  });

  it("renders 100+ once the count is past the cap or the page is truncated", () => {
    expect(formatShotCount(SHOT_COUNT_DISPLAY_CAP + 1)).toBe("100+ files");
    expect(formatShotCount(400)).toBe("100+ files");
    expect(formatShotCount(SHOT_COUNT_DISPLAY_CAP, { truncated: true })).toBe("100+ files");
    expect(formatShotCount(3, { truncated: true })).toBe("100+ files");
  });
});

describe("shotPreviewCaption", () => {
  it("returns just the filename for a non-GitHub shot", () => {
    expect(shotPreviewCaption({ key: "gh/o/r/pull/7/home.webp" })).toEqual({ name: "home.webp" });
  });

  it("adds a PR line + ref + upload time from top-level fields", () => {
    expect(
      shotPreviewCaption({
        key: "gh/o/r/pull/7/home.webp",
        ghKind: "pull",
        ghNumber: "7",
        ghRef: "o/r#7",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toEqual({
      name: "home.webp",
      pr: "PR #7",
      ref: "o/r#7",
      uploadedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reads gh.* from metadata and reconstructs a missing ref from repo+number", () => {
    expect(
      shotPreviewCaption({
        key: "gh/o/r/pull/7/home.webp",
        metadata: { "gh.kind": "pull", "gh.number": "7", "gh.repo": "o/r" },
      }),
    ).toMatchObject({ pr: "PR #7", ref: "o/r#7" });
  });

  it("prefers updatedAt over uploadedAt, and omits ref when there is no PR", () => {
    const cap = shotPreviewCaption({
      key: "shot.webp",
      ghRef: "o/r#7",
      updatedAt: "2026-08-02T00:00:00.000Z",
      uploadedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(cap.uploadedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(cap.ref).toBeUndefined();
    expect(cap.pr).toBeUndefined();
  });
});

describe("projectLabelFromItemMeta", () => {
  // Pinned to the same cases as apps/api projectLabelFromMeta — keep in sync.
  it("prefers repo over gh.repo over url origin", () => {
    expect(
      projectLabelFromItemMeta({ repo: "acme/web", "gh.repo": "acme/api", url: "https://x.dev/p" }),
    ).toBe("acme/web");
    expect(projectLabelFromItemMeta({ "gh.repo": "acme/api" })).toBe("acme/api");
    expect(projectLabelFromItemMeta({ url: "https://staging.x.dev:8443/p" })).toBe(
      "staging.x.dev:8443",
    );
  });
  it("labels context-less local origins 'local dev' instead of the raw host (#692)", () => {
    expect(projectLabelFromItemMeta({ url: "http://localhost:3000/admin" })).toBe("local dev");
    expect(projectLabelFromItemMeta({ url: "https://uploads.localhost/settings" })).toBe(
      "local dev",
    );
    expect(projectLabelFromItemMeta({ url: "http://127.0.0.1:8788/x" })).toBe("local dev");
    expect(projectLabelFromItemMeta({ url: "http://0.0.0.0:4321/" })).toBe("local dev");
    expect(projectLabelFromItemMeta({ url: "http://[::1]:3000/" })).toBe("local dev");
  });
  it("app metadata names local-origin and url-less groups, but never outranks a real host", () => {
    expect(projectLabelFromItemMeta({ url: "http://localhost:3000/admin", app: "web" })).toBe(
      "web",
    );
    expect(projectLabelFromItemMeta({ app: "ios" })).toBe("ios");
    expect(projectLabelFromItemMeta({ url: "https://x.dev/p", app: "web" })).toBe("x.dev");
    expect(projectLabelFromItemMeta({ repo: "acme/web", app: "ios" })).toBe("acme/web");
  });
  it("returns Other for missing/unparseable", () => {
    expect(projectLabelFromItemMeta(undefined)).toBe("Other");
    expect(projectLabelFromItemMeta({})).toBe("Other");
    expect(projectLabelFromItemMeta({ url: "not a url" })).toBe("Other");
  });
});

describe("screenshots view URL state", () => {
  it("round-trips project, path, and q", () => {
    expect(readScreenshotsView("?project=acme%2Fweb&path=%2Fadmin&q=%2Fcat")).toEqual({
      project: "acme/web",
      path: "/admin",
      q: "/cat",
      feed: "grouped",
      merged: false,
    });
    expect(screenshotsSearch("acme/web", "/admin", "/cat")).toBe(
      "?project=acme%2Fweb&path=%2Fadmin&q=%2Fcat",
    );
    expect(screenshotsSearch("acme/web", "")).toBe("?project=acme%2Fweb");
    expect(screenshotsSearch("", "")).toBe("");
    expect(screenshotsSearch("", "", "/catalog")).toBe("?q=%2Fcatalog");
  });
  it("round-trips the recent-feed toggle, defaulting to grouped", () => {
    expect(readScreenshotsView("?view=recent").feed).toBe("recent");
    expect(readScreenshotsView("?view=nonsense").feed).toBe("grouped");
    expect(readScreenshotsView("").feed).toBe("grouped");
    expect(screenshotsSearch("", "", "", "recent")).toBe("?view=recent");
    expect(screenshotsSearch("acme/web", "", "", "recent")).toBe("?project=acme%2Fweb&view=recent");
    expect(screenshotsSearch("", "", "", "grouped")).toBe("");
  });
  it("keeps legacy bare ?path= links working", () => {
    expect(readScreenshotsView("?path=%2Fadmin")).toEqual({
      project: "",
      path: "/admin",
      q: "",
      feed: "grouped",
      merged: false,
    });
    expect(screenshotsSearch("", "/admin")).toBe("?path=%2Fadmin");
  });

  it("round-trips the merged-only toggle, defaulting to false", () => {
    expect(readScreenshotsView("?merged=1").merged).toBe(true);
    expect(readScreenshotsView("?merged=0").merged).toBe(false);
    expect(readScreenshotsView("").merged).toBe(false);
    expect(screenshotsSearch("", "", "", "grouped", true)).toBe("?merged=1");
    expect(screenshotsSearch("", "", "", "grouped", false)).toBe("");
    expect(screenshotsSearch("acme/web", "", "", "recent", true)).toBe(
      "?project=acme%2Fweb&view=recent&merged=1",
    );
  });
});

describe("screenshots view hrefs and history mode", () => {
  const overview: ScreenshotsView = {
    project: "",
    path: "",
    q: "",
    feed: "grouped",
    merged: false,
  };

  it("builds a path-based screenshots URL with encoded query state", () => {
    expect(
      screenshotsViewHref("acme", {
        project: "acme/web",
        path: "/admin",
        q: "",
        feed: "grouped",
        merged: false,
      }),
    ).toBe("/account/workspaces/acme/screenshots?project=acme%2Fweb&path=%2Fadmin");
    expect(screenshotsViewHref("acme", overview)).toBe("/account/workspaces/acme/screenshots");
    expect(screenshotsSearchFromView(overview)).toBe("");
  });

  it("pushes history for project or path changes, replaces for filter tweaks", () => {
    expect(screenshotsHistoryMode(overview, { ...overview, path: "/settings" })).toBe("push");
    expect(screenshotsHistoryMode(overview, { ...overview, project: "acme/web" })).toBe("push");
    expect(screenshotsHistoryMode(overview, { ...overview, q: "/cat" })).toBe("replace");
    expect(screenshotsHistoryMode(overview, { ...overview, feed: "recent" })).toBe("replace");
    expect(screenshotsHistoryMode(overview, { ...overview, merged: true })).toBe("replace");
  });

  it("treats views as equal only when every field matches", () => {
    expect(screenshotsViewsEqual(overview, { ...overview })).toBe(true);
    expect(screenshotsViewsEqual(overview, { ...overview, path: "/x" })).toBe(false);
  });

  it("recognizes the nav marker on a ClientRouter-shaped history state", () => {
    expect(isScreenshotsNavState({ index: 2, scrollX: 0, scrollY: 0 })).toBe(false);
    expect(
      isScreenshotsNavState({
        index: 2,
        scrollX: 0,
        scrollY: 0,
        uploadsScreenshotsNav: true,
      }),
    ).toBe(true);
    expect(isScreenshotsNavState(null)).toBe(false);
  });
});

describe("isRepoLabel", () => {
  it("flags owner/name labels and nothing else", () => {
    expect(isRepoLabel("acme/web")).toBe(true);
    expect(isRepoLabel("app.example.com")).toBe(false);
    expect(isRepoLabel("local dev")).toBe(false);
    expect(isRepoLabel("Other")).toBe(false);
  });
});

describe("pathSuggestions", () => {
  const catalog = [
    { project: "acme/web", path: "/admin", count: 3 },
    { project: "acme/api", path: "/admin", count: 2 },
    { project: "acme/web", path: "/catalog/families", count: 5 },
  ];
  it("dedupes the same path across projects, summing counts", () => {
    expect(pathSuggestions(catalog, { project: "", q: "" })).toEqual([
      { path: "/admin", count: 5 },
      { path: "/catalog/families", count: 5 },
    ]);
  });
  it("respects the project scope and path query", () => {
    expect(pathSuggestions(catalog, { project: "acme/web", q: "/admin" })).toEqual([
      { path: "/admin", count: 3 },
    ]);
    expect(pathSuggestions(catalog, { project: "", q: "cat" })).toEqual([
      { path: "/catalog/families", count: 5 },
    ]);
  });

  it("matches a half-typed segment by substring, unlike pathQueryMatches", () => {
    expect(pathSuggestions(catalog, { project: "", q: "/ca" })).toEqual([
      { path: "/catalog/families", count: 5 },
    ]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      project: "acme/web",
      path: `/page-${i}`,
      count: 1,
    }));
    expect(pathSuggestions(many, { project: "", q: "" })).toHaveLength(8);
  });
});

describe("pathQueryMatches", () => {
  it("treats a leading slash as a path-segment prefix", () => {
    expect(pathQueryMatches("/catalog", "/catalog")).toBe(true);
    expect(pathQueryMatches("/catalog/families/ezel", "/catalog")).toBe(true);
    expect(pathQueryMatches("/catalog/families/ezel", "/catalog/")).toBe(true);
    expect(pathQueryMatches("/catalogue", "/catalog")).toBe(false);
    expect(pathQueryMatches("/admin/catalog", "/catalog")).toBe(false);
  });
  it("treats a slash-less query as a case-insensitive substring", () => {
    expect(pathQueryMatches("/Catalog/Families", "famil")).toBe(true);
    expect(pathQueryMatches("/admin/oauth", "OAuth")).toBe(true);
    expect(pathQueryMatches("/home", "zzz")).toBe(false);
  });
  it("matches everything when the query is empty", () => {
    expect(pathQueryMatches("/home", "")).toBe(true);
    expect(pathQueryMatches("/home", "  ")).toBe(true);
  });
});

describe("filterCatalog", () => {
  const catalog = [
    { project: "acme/web", path: "/catalog/families/ezel", count: 6, lastUpdated: "2" },
    { project: "acme/web", path: "/admin", count: 2, lastUpdated: "1" },
    { project: "local dev", path: "/catalog", count: 1, lastUpdated: "3" },
  ];
  it("filters by project and path query together", () => {
    expect(
      filterCatalog(catalog, { project: "acme/web", q: "/catalog" }).map((e) => e.path),
    ).toEqual(["/catalog/families/ezel"]);
    expect(filterCatalog(catalog, { project: "", q: "/catalog" }).map((e) => e.project)).toEqual([
      "acme/web",
      "local dev",
    ]);
    expect(filterCatalog(catalog, { project: "acme/web", q: "" })).toHaveLength(2);
  });
});

describe("groupsFromCatalog", () => {
  it("prefers a thumbed group's strip and keeps the catalog's own otherwise", () => {
    const catalog = [
      {
        project: "acme/web",
        path: "/admin",
        count: 2,
        lastUpdated: "2",
        recent: [{ key: "short.png", url: null, embedUrl: null }],
      },
      {
        project: "acme/web",
        path: "/older",
        count: 1,
        lastUpdated: "1",
        recent: [{ key: "o.png", url: null, embedUrl: null }],
      },
    ];
    const groups = [
      {
        project: "acme/web",
        path: "/admin",
        count: 2,
        lastUpdated: "2",
        recent: [{ key: "a.png", url: null, embedUrl: null }],
      },
    ];
    expect(groupsFromCatalog(catalog, groups)).toEqual([groups[0], catalog[1]]);
  });
});

describe("shotPreviewCaption", () => {
  it("uses the leaf filename and a compact PR/issue line", () => {
    expect(leafName("shots/typical-modal-stage.webp")).toBe("typical-modal-stage.webp");
    expect(
      shotPreviewCaption({ key: "shots/typical-modal-stage.webp", ghKind: "pull", ghNumber: "42" }),
    ).toEqual({ name: "typical-modal-stage.webp", pr: "PR #42" });
    expect(
      shotPreviewCaption({
        key: "shots/a.png",
        metadata: { "gh.kind": "issue", "gh.number": "7" },
      }),
    ).toEqual({ name: "a.png", pr: "Issue #7" });
  });
  it("omits the PR line when GitHub metadata is missing", () => {
    expect(shotPreviewCaption({ key: "shots/plain.webp" })).toEqual({ name: "plain.webp" });
    expect(shotPreviewCaption({ key: "shots/a.png", ghKind: "pull" })).toEqual({ name: "a.png" });
  });
});

describe("shotPreviewPosition", () => {
  const preview = { width: 480, height: 300 };
  const viewport = { width: 1200, height: 800 };
  it("prefers the right side when there is room", () => {
    expect(
      shotPreviewPosition({ left: 20, top: 40, right: 188, bottom: 166 }, viewport, preview),
    ).toEqual({ left: 200, top: 40 });
  });
  it("flips to the left when the right side would clip", () => {
    expect(
      shotPreviewPosition({ left: 900, top: 40, right: 1068, bottom: 166 }, viewport, preview),
    ).toEqual({ left: 408, top: 40 });
  });
  it("clamps vertically when the preview would run off the bottom", () => {
    const pos = shotPreviewPosition(
      { left: 20, top: 700, right: 188, bottom: 826 },
      viewport,
      preview,
    );
    expect(pos.top).toBe(492); // 800 - 8 - 300
    expect(pos.left).toBe(200);
  });
});

describe("focusIsKeyboardDriven", () => {
  it("opens the preview for a genuine :focus-visible match", () => {
    expect(focusIsKeyboardDriven({ matches: (s) => s === ":focus-visible" })).toBe(true);
  });
  it("skips a focus that isn't :focus-visible (e.g. a touch tap)", () => {
    expect(focusIsKeyboardDriven({ matches: () => false })).toBe(false);
  });
  it("treats a missing element as not keyboard-driven", () => {
    expect(focusIsKeyboardDriven(null)).toBe(false);
  });
  it("treats an engine that throws on :focus-visible as not keyboard-driven", () => {
    expect(
      focusIsKeyboardDriven({
        matches: () => {
          throw new DOMException("unsupported selector", "SyntaxError");
        },
      }),
    ).toBe(false);
  });
});
