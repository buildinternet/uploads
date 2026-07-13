import { describe, expect, it } from "vitest";
import {
  applyBrowseLocation,
  isBrowseWorkspace,
  normalizeBrowsePath,
  readBrowseLocation,
} from "./workspace-browse-url";

describe("normalizeBrowsePath", () => {
  it("normalizes folder prefixes with a trailing slash", () => {
    expect(normalizeBrowsePath("screenshots/releases")).toBe("screenshots/releases/");
    expect(normalizeBrowsePath("/screenshots/releases/")).toBe("screenshots/releases/");
    expect(normalizeBrowsePath("  f/x  ")).toBe("f/x/");
  });

  it("returns empty for root or unsafe paths", () => {
    expect(normalizeBrowsePath("")).toBe("");
    expect(normalizeBrowsePath("/")).toBe("");
    expect(normalizeBrowsePath("../etc")).toBe("");
    expect(normalizeBrowsePath("a/../b")).toBe("");
    expect(normalizeBrowsePath("a/./b")).toBe("");
  });
});

describe("readBrowseLocation", () => {
  it("parses ws + path and ignores invalid workspace slugs", () => {
    expect(readBrowseLocation("?ws=buildinternet&path=screenshots/releases")).toEqual({
      workspace: "buildinternet",
      path: "screenshots/releases/",
    });
    expect(readBrowseLocation("?ws=Not_Valid&path=x")).toEqual({
      workspace: "",
      path: "",
    });
    expect(readBrowseLocation("?path=orphan")).toEqual({
      workspace: "",
      path: "",
    });
  });
});

describe("applyBrowseLocation", () => {
  it("sets and clears query params without clobbering other search keys", () => {
    const base = new URL("https://uploads.sh/account/workspaces?tab=1");
    const withPath = applyBrowseLocation(base, {
      workspace: "buildinternet",
      path: "screenshots/",
    });
    expect(withPath.searchParams.get("ws")).toBe("buildinternet");
    expect(withPath.searchParams.get("path")).toBe("screenshots/");
    expect(withPath.searchParams.get("tab")).toBe("1");

    const cleared = applyBrowseLocation(withPath, { workspace: "", path: "ignored" });
    expect(cleared.searchParams.get("ws")).toBeNull();
    expect(cleared.searchParams.get("path")).toBeNull();
    expect(cleared.searchParams.get("tab")).toBe("1");
  });
});

describe("isBrowseWorkspace", () => {
  it("matches the API workspace name shape", () => {
    expect(isBrowseWorkspace("buildinternet")).toBe(true);
    expect(isBrowseWorkspace("ab")).toBe(true);
    expect(isBrowseWorkspace("a")).toBe(false);
    expect(isBrowseWorkspace("BuildInternet")).toBe(false);
  });
});
