import { describe, expect, it } from "vitest";
import {
  lastUpdatedLabel,
  pairedShotKeys,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsSearch,
  shotKindFromKey,
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

describe("projectLabelFromItemMeta", () => {
  // Pinned to the same cases as apps/api projectLabelFromMeta — keep in sync.
  it("prefers repo over gh.repo over url origin", () => {
    expect(
      projectLabelFromItemMeta({ repo: "acme/web", "gh.repo": "acme/api", url: "https://x.dev/p" }),
    ).toBe("acme/web");
    expect(projectLabelFromItemMeta({ "gh.repo": "acme/api" })).toBe("acme/api");
    expect(projectLabelFromItemMeta({ url: "http://localhost:3000/admin" })).toBe("localhost:3000");
  });
  it("returns Other for missing/unparseable", () => {
    expect(projectLabelFromItemMeta(undefined)).toBe("Other");
    expect(projectLabelFromItemMeta({})).toBe("Other");
    expect(projectLabelFromItemMeta({ url: "not a url" })).toBe("Other");
  });
});

describe("screenshots view URL state", () => {
  it("round-trips project and path", () => {
    expect(readScreenshotsView("?project=acme%2Fweb&path=%2Fadmin")).toEqual({
      project: "acme/web",
      path: "/admin",
    });
    expect(screenshotsSearch("acme/web", "/admin")).toBe("?project=acme%2Fweb&path=%2Fadmin");
    expect(screenshotsSearch("acme/web", "")).toBe("?project=acme%2Fweb");
    expect(screenshotsSearch("", "")).toBe("");
  });
  it("keeps legacy bare ?path= links working", () => {
    expect(readScreenshotsView("?path=%2Fadmin")).toEqual({ project: "", path: "/admin" });
    expect(screenshotsSearch("", "/admin")).toBe("?path=%2Fadmin");
  });
});
