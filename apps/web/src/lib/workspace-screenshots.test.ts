import { describe, expect, it } from "vitest";
import {
  lastUpdatedLabel,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsSearch,
  shotKindFromKey,
} from "./workspace-screenshots";

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
