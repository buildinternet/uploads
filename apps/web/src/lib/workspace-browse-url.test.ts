import { describe, expect, it } from "vitest";
import {
  applyBrowseLocation,
  isBrowseWorkspace,
  normalizeBrowsePath,
  readBrowseLocation,
  workspaceFromPathname,
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

describe("workspaceFromPathname", () => {
  it("reads the workspace slug from the dedicated route", () => {
    expect(workspaceFromPathname("/account/workspaces/buildinternet")).toBe("buildinternet");
    expect(workspaceFromPathname("/account/workspaces/buildinternet/")).toBe("buildinternet");
  });

  it("reads the workspace slug from nested workspace pages", () => {
    expect(workspaceFromPathname("/account/workspaces/buildinternet/invite")).toBe("buildinternet");
    expect(workspaceFromPathname("/account/workspaces/buildinternet/invite/")).toBe(
      "buildinternet",
    );
  });

  it("ignores index, create, and invalid slugs", () => {
    expect(workspaceFromPathname("/account/workspaces")).toBe("");
    expect(workspaceFromPathname("/account/workspaces/new")).toBe("");
    expect(workspaceFromPathname("/account/workspaces/Not_Valid")).toBe("");
    expect(workspaceFromPathname("/account")).toBe("");
  });
});

describe("readBrowseLocation", () => {
  it("parses path-based workspace + path query", () => {
    expect(
      readBrowseLocation("?path=screenshots/releases", "/account/workspaces/buildinternet"),
    ).toEqual({
      workspace: "buildinternet",
      path: "screenshots/releases/",
    });
  });

  it("falls back to legacy ?ws= when pathname has no slug", () => {
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
  it("writes path-based workspace routes and keeps other search keys", () => {
    const base = new URL("https://uploads.sh/account/workspaces?tab=1");
    const withPath = applyBrowseLocation(base, {
      workspace: "buildinternet",
      path: "screenshots/",
    });
    expect(withPath.pathname).toBe("/account/workspaces/buildinternet");
    expect(withPath.searchParams.get("ws")).toBeNull();
    expect(withPath.searchParams.get("path")).toBe("screenshots/");
    expect(withPath.searchParams.get("tab")).toBe("1");

    const cleared = applyBrowseLocation(withPath, { workspace: "", path: "ignored" });
    expect(cleared.searchParams.get("ws")).toBeNull();
    expect(cleared.searchParams.get("path")).toBeNull();
    expect(cleared.searchParams.get("tab")).toBe("1");
  });

  it("updates path only when already on the workspace page", () => {
    const base = new URL("https://uploads.sh/account/workspaces/buildinternet?path=old/");
    const next = applyBrowseLocation(base, {
      workspace: "buildinternet",
      path: "screenshots/",
    });
    expect(next.pathname).toBe("/account/workspaces/buildinternet");
    expect(next.searchParams.get("path")).toBe("screenshots/");
  });
});

describe("isBrowseWorkspace", () => {
  it("matches the API workspace name shape and excludes route reserved names", () => {
    expect(isBrowseWorkspace("buildinternet")).toBe(true);
    expect(isBrowseWorkspace("ab")).toBe(true);
    expect(isBrowseWorkspace("a")).toBe(false);
    expect(isBrowseWorkspace("BuildInternet")).toBe(false);
    expect(isBrowseWorkspace("new")).toBe(false);
  });
});
