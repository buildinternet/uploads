import { describe, expect, it } from "vitest";
import {
  appendPage,
  groupScopeItemsByPath,
  keepPairsTogether,
  openPullsLabel,
  pairCells,
  scopeEmptyCopy,
  scopeItemToTile,
  thumbToTile,
  type ScopeItemDto,
} from "./files-scope";

const tile = (key: string, state?: string, path: string | null = null) => ({
  key,
  path,
  ...(state ? { state } : {}),
});

describe("keepPairsTogether", () => {
  it("pulls a before/after counterpart next to the first member seen, before first", () => {
    const ordered = keepPairsTogether([
      tile("p/hero-after.png", "after"),
      tile("p/other.png"),
      tile("p/hero-before.png", "before"),
    ]);
    expect(ordered.map((t) => t.key)).toEqual([
      "p/hero-before.png",
      "p/hero-after.png",
      "p/other.png",
    ]);
  });

  it("keeps a pair together even when its halves arrived on different pages", () => {
    const pageOne = [tile("p/a-after.png", "after"), tile("p/b.png")];
    const pageTwo = [tile("p/c.png"), tile("p/a-before.png", "before")];
    const all = appendPage(pageOne, pageTwo, (t) => t.key);
    expect(keepPairsTogether(all).map((t) => t.key)).toEqual([
      "p/a-before.png",
      "p/a-after.png",
      "p/b.png",
      "p/c.png",
    ]);
  });

  it("leaves unpaired items in their original order", () => {
    const items = [tile("a.png"), tile("b.png", "after"), tile("c.png")];
    expect(keepPairsTogether(items)).toEqual(items);
  });
});

describe("pairCells", () => {
  it("makes one cell per pair (before first) at the newer member's position", () => {
    const cells = pairCells([
      tile("p/new.png"),
      tile("p/hero-after.png", "after"),
      tile("p/other.png"),
      tile("p/hero-before.png", "before"),
    ]);
    expect(
      cells.map((cell) => (cell.kind === "pair" ? cell.items.map((t) => t.key) : cell.item.key)),
    ).toEqual(["p/new.png", ["p/hero-before.png", "p/hero-after.png"], "p/other.png"]);
  });

  it("keeps single tiles as single cells", () => {
    expect(pairCells([tile("a.png"), tile("b.png", "after")])).toEqual([
      { kind: "single", item: tile("a.png") },
      { kind: "single", item: tile("b.png", "after") },
    ]);
  });
});

describe("groupScopeItemsByPath", () => {
  it("keeps pathed groups in first-seen (newest-first) order with pairs kept, and No page last", () => {
    const groups = groupScopeItemsByPath([
      tile("x/home-after.png", "after", "/home"),
      tile("x/doc.pdf", undefined, null),
      tile("x/settings.png", undefined, "/settings"),
      tile("x/home-before.png", "before", "/home"),
      tile("x/about.png", undefined, "/about"),
    ]);
    expect(groups.map((g) => [g.path, g.items.map((t) => t.key)])).toEqual([
      ["/home", ["x/home-before.png", "x/home-after.png"]],
      ["/settings", ["x/settings.png"]],
      ["/about", ["x/about.png"]],
      [null, ["x/doc.pdf"]],
    ]);
  });

  it("sorts No page last even when the newest item has no path", () => {
    const groups = groupScopeItemsByPath([
      tile("x/a.png", undefined, null),
      tile("x/b.png", undefined, "/b"),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["/b", null]);
  });
});

describe("groupScopeItemsByPath path normalization", () => {
  it("treats empty, whitespace, and bare slash paths as no path, and trims real ones", () => {
    const groups = groupScopeItemsByPath([
      tile("x/a.png", undefined, "/"),
      tile("x/b.png", undefined, ""),
      tile("x/c.png", undefined, "   "),
      tile("x/d.png", undefined, null),
      tile("x/e.png", undefined, " /home "),
      tile("x/f.png", undefined, "/home"),
    ]);
    expect(groups.map((g) => [g.path, g.items.map((t) => t.key)])).toEqual([
      ["/home", ["x/e.png", "x/f.png"]],
      [null, ["x/a.png", "x/b.png", "x/c.png", "x/d.png"]],
    ]);
  });
});

describe("appendPage", () => {
  it("appends and drops rows already present", () => {
    expect(appendPage([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], (r) => r.id)).toEqual(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
    );
  });
});

describe("tile mappers", () => {
  it("maps a scope item DTO to a tile keyed by objectKey", () => {
    const dto = {
      id: "i1",
      objectKey: "pull/7/after.png",
      filename: "after.png",
      status: "available",
      url: "https://s/after.png",
      embedUrl: "https://e/after.png",
      contentType: "image/png",
      size: 10,
      uploaded: "2026-10-01T00:00:00.000Z",
      modified: "2026-10-02T00:00:00.000Z",
      path: "/home",
      state: "after",
    } as ScopeItemDto;
    expect(scopeItemToTile(dto)).toEqual({
      key: "pull/7/after.png",
      url: "https://s/after.png",
      embedUrl: "https://e/after.png",
      status: "available",
      contentType: "image/png",
      posterUrl: null,
      state: "after",
      path: "/home",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("maps a row thumbnail to a tile", () => {
    expect(
      thumbToTile({
        key: "pull/7/demo.mp4",
        kind: "video",
        url: "https://s/demo.mp4",
        embedUrl: null,
        posterUrl: "https://s/demo.poster.jpg",
        status: "available",
      }),
    ).toEqual({
      key: "pull/7/demo.mp4",
      url: "https://s/demo.mp4",
      embedUrl: null,
      status: "available",
      contentType: null,
      posterUrl: "https://s/demo.poster.jpg",
      path: null,
    });
  });
});

describe("openPullsLabel", () => {
  it("pluralizes and names zero", () => {
    expect(openPullsLabel(0)).toBe("no open PRs");
    expect(openPullsLabel(1)).toBe("1 open PR");
    expect(openPullsLabel(3)).toBe("3 open PRs");
  });
});

describe("scopeEmptyCopy", () => {
  it("gives a PR with zero in-scope items an empty state with the PR's own put command", () => {
    expect(scopeEmptyCopy({ number: 7, type: null })).toEqual({
      title: "No files on this pull request",
      description:
        "Files attached with --pr show up here, newest first. Files removed from the pull request drop off.",
      command: "uploads put ./shot.png --pr 7",
    });
  });

  it("names the type and drops the command when a type filter is on", () => {
    expect(scopeEmptyCopy({ number: 7, type: "video" })).toEqual({
      title: "No videos on this pull request",
      description: "Clear the type filter to see every file.",
      command: null,
    });
    expect(scopeEmptyCopy({ number: null, type: "other" }).title).toBe(
      "No other files in this repo",
    );
  });

  it("covers an empty repo", () => {
    expect(scopeEmptyCopy({ number: null, type: null }).title).toBe("No files in this repo");
  });
});
