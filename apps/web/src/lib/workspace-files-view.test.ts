import { describe, expect, it } from "vitest";
import {
  applyFilesView,
  parseFilesView,
  readFilesViewParam,
  resolveFilesView,
} from "./workspace-files-view";

describe("parseFilesView", () => {
  it("accepts list and grid", () => {
    expect(parseFilesView("list")).toBe("list");
    expect(parseFilesView("grid")).toBe("grid");
  });

  it("rejects unknown values", () => {
    expect(parseFilesView("cards")).toBeNull();
    expect(parseFilesView("")).toBeNull();
    expect(parseFilesView(null)).toBeNull();
    expect(parseFilesView(undefined)).toBeNull();
  });
});

describe("readFilesViewParam", () => {
  it("reads view from a query string", () => {
    expect(readFilesViewParam("?path=screenshots/&view=grid")).toBe("grid");
    expect(readFilesViewParam("view=list&meta.gh.repo=a/b")).toBe("list");
  });

  it("returns null when the param is missing or invalid", () => {
    expect(readFilesViewParam("?path=screenshots/")).toBeNull();
    expect(readFilesViewParam("?view=masonry")).toBeNull();
  });
});

describe("resolveFilesView", () => {
  it("prefers the URL over a stored preference", () => {
    expect(resolveFilesView("?view=list", "grid")).toBe("list");
    expect(resolveFilesView("?view=grid", "list")).toBe("grid");
  });

  it("falls back to storage, then list", () => {
    expect(resolveFilesView("", "grid")).toBe("grid");
    expect(resolveFilesView("?path=f/", "list")).toBe("list");
    expect(resolveFilesView("", null)).toBe("list");
    expect(resolveFilesView("", "cards")).toBe("list");
  });
});

describe("applyFilesView", () => {
  it("sets view without clobbering other params", () => {
    const base = new URL("https://uploads.sh/account/workspaces/acme?path=screenshots/");
    const next = applyFilesView(base, "grid");
    expect(next.searchParams.get("view")).toBe("grid");
    expect(next.searchParams.get("path")).toBe("screenshots/");
  });

  it("can override a prior view value", () => {
    const base = new URL("https://uploads.sh/account/workspaces/acme?view=grid");
    expect(applyFilesView(base, "list").searchParams.get("view")).toBe("list");
  });
});
