import { describe, expect, it } from "vitest";
import {
  applyGalleriesView,
  parseGalleriesView,
  readGalleriesViewParam,
  resolveGalleriesView,
} from "./workspace-galleries-view";

describe("parseGalleriesView", () => {
  it("accepts grid and list", () => {
    expect(parseGalleriesView("grid")).toBe("grid");
    expect(parseGalleriesView("list")).toBe("list");
  });

  it("rejects unknown values", () => {
    expect(parseGalleriesView("cards")).toBeNull();
    expect(parseGalleriesView("")).toBeNull();
    expect(parseGalleriesView(null)).toBeNull();
    expect(parseGalleriesView(undefined)).toBeNull();
  });
});

describe("readGalleriesViewParam", () => {
  it("reads view from a query string", () => {
    expect(readGalleriesViewParam("?tab=x&view=list")).toBe("list");
    expect(readGalleriesViewParam("view=grid")).toBe("grid");
  });

  it("returns null when the param is missing or invalid", () => {
    expect(readGalleriesViewParam("?tab=x")).toBeNull();
    expect(readGalleriesViewParam("?view=masonry")).toBeNull();
  });
});

describe("resolveGalleriesView", () => {
  it("prefers the URL over a stored preference", () => {
    expect(resolveGalleriesView("?view=list", "grid")).toBe("list");
    expect(resolveGalleriesView("?view=grid", "list")).toBe("grid");
  });

  it("falls back to storage, then to grid (the tab's default)", () => {
    expect(resolveGalleriesView("", "list")).toBe("list");
    // Unlike the files tab (which defaults to list), galleries default to grid.
    expect(resolveGalleriesView("", null)).toBe("grid");
    expect(resolveGalleriesView("", "nonsense")).toBe("grid");
  });
});

describe("applyGalleriesView", () => {
  it("sets view explicitly so ?view=list can override storage", () => {
    const url = new URL("https://uploads.sh/account/workspaces/acme/galleries");
    expect(applyGalleriesView(url, "list").search).toBe("?view=list");
    expect(applyGalleriesView(new URL("https://x.test/?view=grid"), "list").search).toBe(
      "?view=list",
    );
  });
});
