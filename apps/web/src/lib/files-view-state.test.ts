import { describe, expect, it } from "vitest";
import {
  canonicalScopePath,
  filesPrHref,
  filesPrHrefForWorkItem,
  filesRepoHref,
  filesSearch,
  filesViewHref,
  linksHref,
  matchesTypeFilter,
  normalizeRepoFilter,
  normalizeRepoParam,
  parseFileTypeParam,
  parsePrNumberParam,
  prStateFromTitle,
  pullsEmptyCopy,
  readFilesQuery,
  readFilesView,
  readScopePageQuery,
  scopePageSearch,
  typeEmptyNoun,
} from "./files-view-state";
import { filesRouteRedirect } from "./workspace-route-redirects";

describe("readFilesView", () => {
  it("defaults to pulls and accepts only repos and pages", () => {
    expect(readFilesView("")).toBe("pulls");
    expect(readFilesView("?view=repos")).toBe("repos");
    expect(readFilesView("view=pages")).toBe("pages");
    expect(readFilesView("?view=recent")).toBe("pulls");
    expect(readFilesView("?view=PAGES")).toBe("pulls");
  });
});

describe("readFilesQuery / filesSearch", () => {
  it("reads every filter on the pulls view and round-trips", () => {
    const query = readFilesQuery("?type=video&repo=Acme%2FWeb&state=merged");
    expect(query).toEqual({
      view: "pulls",
      type: "video",
      repo: "acme/web",
      state: "merged",
      all: false,
    });
    expect(filesSearch(query)).toBe("?type=video&repo=acme%2Fweb&state=merged");
  });

  it("round-trips all=1 (Show older pull requests) on the pulls view only", () => {
    const query = readFilesQuery("?repo=acme%2Fweb&all=1");
    expect(query).toEqual({ view: "pulls", type: null, repo: "acme/web", state: null, all: true });
    expect(filesSearch(query)).toBe("?repo=acme%2Fweb&all=1");
    expect(readFilesQuery("?all=yes").all).toBe(false);
    expect(readFilesQuery("?view=repos&all=1").all).toBe(false);
    expect(filesSearch({ view: "repos", type: null, repo: "", state: null, all: true })).toBe(
      "?view=repos",
    );
  });

  it("drops unknown values instead of failing", () => {
    expect(readFilesQuery("?type=gif&state=draft&repo=nope")).toEqual({
      view: "pulls",
      type: null,
      repo: "",
      state: null,
      all: false,
    });
  });

  it("ignores repo and state outside the pulls view", () => {
    expect(readFilesQuery("?view=repos&type=other&repo=a%2Fb&state=open")).toEqual({
      view: "repos",
      type: "other",
      repo: "",
      state: null,
      all: false,
    });
    expect(
      filesSearch({ view: "repos", type: "other", repo: "a/b", state: "open", all: false }),
    ).toBe("?view=repos&type=other");
  });

  it("omits every default", () => {
    expect(filesSearch({ view: "pulls", type: null, repo: "", state: null, all: false })).toBe("");
  });
});

describe("readScopePageQuery / scopePageSearch", () => {
  it("round-trips type and group=path", () => {
    expect(readScopePageQuery("?type=screenshot&group=path")).toEqual({
      type: "screenshot",
      groupByPath: true,
    });
    expect(scopePageSearch({ type: "screenshot", groupByPath: true })).toBe(
      "?type=screenshot&group=path",
    );
    expect(readScopePageQuery("?group=yes")).toEqual({ type: null, groupByPath: false });
    expect(scopePageSearch({ type: null, groupByPath: false })).toBe("");
  });
});

describe("normalizeRepoParam / normalizeRepoFilter", () => {
  it("lowercases and keeps dots, dashes, underscores (index Review Focus 2)", () => {
    expect(normalizeRepoParam("Foo.Bar", "My-Repo")).toBe("foo.bar/my-repo");
    expect(normalizeRepoParam("acme", "my_repo")).toBe("acme/my_repo");
    expect(normalizeRepoParam("acme", ".github")).toBe("acme/.github");
  });

  it("rejects empty, dot-only, slash-bearing, and over-long segments", () => {
    expect(normalizeRepoParam("", "web")).toBeNull();
    expect(normalizeRepoParam("acme", "..")).toBeNull();
    expect(normalizeRepoParam("acme", ".")).toBeNull();
    expect(normalizeRepoParam("acme", "a/b")).toBeNull();
    expect(normalizeRepoParam("acme", "x".repeat(101))).toBeNull();
    expect(normalizeRepoParam("ac me", "web")).toBeNull();
  });

  it("parses an owner/repo filter value", () => {
    expect(normalizeRepoFilter("Acme/Web")).toBe("acme/web");
    expect(normalizeRepoFilter("acme")).toBe("");
    expect(normalizeRepoFilter("/web")).toBe("");
    expect(normalizeRepoFilter(null)).toBe("");
  });
});

describe("parsePrNumberParam", () => {
  it("accepts positive integers only", () => {
    expect(parsePrNumberParam("123")).toBe(123);
    expect(parsePrNumberParam("007")).toBe(7);
    expect(parsePrNumberParam("0")).toBeNull();
    expect(parsePrNumberParam("-1")).toBeNull();
    expect(parsePrNumberParam("1e3")).toBeNull();
    expect(parsePrNumberParam("12abc")).toBeNull();
    expect(parsePrNumberParam("")).toBeNull();
    expect(parsePrNumberParam(undefined)).toBeNull();
    expect(parsePrNumberParam("1234567890")).toBeNull();
  });
});

describe("route builders", () => {
  it("builds view, repo, PR, and Links paths", () => {
    expect(filesViewHref("acme", "pulls")).toBe("/account/workspaces/acme/files");
    expect(filesViewHref("acme", "pages")).toBe("/account/workspaces/acme/files?view=pages");
    expect(filesRepoHref("acme", "Acme/Web")).toBe("/account/workspaces/acme/files/acme/web");
    expect(filesPrHref("acme", "acme/web", 7)).toBe(
      "/account/workspaces/acme/files/acme/web/pull/7",
    );
    expect(linksHref("acme")).toBe("/account/workspaces/acme/links");
  });

  it("falls back to the list view for an invalid repo", () => {
    expect(filesRepoHref("acme", "not-a-repo")).toBe("/account/workspaces/acme/files?view=repos");
    expect(filesPrHref("acme", "not-a-repo", 7)).toBe("/account/workspaces/acme/files");
    expect(filesPrHref("acme", "acme/web", 0)).toBe("/account/workspaces/acme/files");
    expect(filesPrHref("acme", "acme/web", -1)).toBe("/account/workspaces/acme/files");
    expect(filesPrHref("acme", "acme/web", 1.5)).toBe("/account/workspaces/acme/files");
    expect(filesPrHref("acme", "acme/web", Number.NaN)).toBe("/account/workspaces/acme/files");
  });

  it("maps a connected-work pull item to its Files PR page, and nothing else", () => {
    expect(filesPrHrefForWorkItem("acme", { kind: "pull", repo: "Acme/Web", number: "7" })).toBe(
      "/account/workspaces/acme/files/acme/web/pull/7",
    );
    expect(
      filesPrHrefForWorkItem("acme", { kind: "issue", repo: "acme/web", number: "7" }),
    ).toBeNull();
    expect(filesPrHrefForWorkItem("acme", { kind: "pull", repo: "acme", number: "7" })).toBeNull();
    expect(
      filesPrHrefForWorkItem("acme", { kind: "pull", repo: "acme/web", number: "x" }),
    ).toBeNull();
  });
});

describe("canonicalScopePath (Review Focus 3)", () => {
  it("lowercases owner/repo and strips leading zeros from the PR number", () => {
    expect(
      canonicalScopePath("acme", { owner: "Foo.Bar", repo: "My-Repo", number: "007" }),
    ).toEqual({
      repo: "foo.bar/my-repo",
      number: 7,
      path: "/account/workspaces/acme/files/foo.bar/my-repo/pull/7",
    });
    expect(canonicalScopePath("acme", { owner: "Acme", repo: "Web" })).toEqual({
      repo: "acme/web",
      number: null,
      path: "/account/workspaces/acme/files/acme/web",
    });
  });

  it("returns null for an invalid owner, repo, or number", () => {
    expect(canonicalScopePath("acme", { owner: "..", repo: "web" })).toBeNull();
    expect(canonicalScopePath("acme", { owner: "acme", repo: "web", number: "0" })).toBeNull();
    expect(canonicalScopePath("acme", {})).toBeNull();
  });
});

describe("small mappers", () => {
  it("parses file type params", () => {
    expect(parseFileTypeParam("screenshot")).toBe("screenshot");
    expect(parseFileTypeParam("video")).toBe("video");
    expect(parseFileTypeParam("other")).toBe("other");
    expect(parseFileTypeParam("screenshots")).toBeNull();
    expect(parseFileTypeParam(null)).toBeNull();
  });

  it("matches the type filter by key extension", () => {
    expect(matchesTypeFilter("a.png", null)).toBe(true);
    expect(matchesTypeFilter("a.PNG", "screenshot")).toBe(true);
    expect(matchesTypeFilter("a.mov", "video")).toBe(true);
    expect(matchesTypeFilter("a.pdf", "video")).toBe(false);
    expect(matchesTypeFilter("a.pdf", "other")).toBe(true);
  });

  it("maps a resolved title state to a PR state", () => {
    expect(prStateFromTitle("merged")).toBe("merged");
    expect(prStateFromTitle("open")).toBe("open");
    expect(prStateFromTitle("draft")).toBeNull();
    expect(prStateFromTitle(null)).toBeNull();
  });

  it("names the empty-state noun for each type", () => {
    expect(typeEmptyNoun(null)).toBe("files");
    expect(typeEmptyNoun("screenshot")).toBe("screenshots");
    expect(typeEmptyNoun("video")).toBe("videos");
    expect(typeEmptyNoun("other")).toBe("other files");
  });
});

describe("Files URLs are never redirected to Storage", () => {
  it("keeps every builder output on /files", () => {
    const searches = [
      filesSearch({ view: "pulls", type: "video", repo: "acme/web", state: "merged", all: false }),
      filesSearch({ view: "pulls", type: null, repo: "acme/web", state: null, all: false }),
      filesSearch({ view: "pulls", type: null, repo: "", state: "open", all: false }),
      filesSearch({ view: "pulls", type: null, repo: "", state: null, all: true }),
      filesSearch({ view: "pulls", type: "video", repo: "acme/web", state: null, all: true }),
      filesSearch({ view: "repos", type: "other", repo: "", state: null, all: false }),
      filesSearch({ view: "pages", type: "screenshot", repo: "", state: null, all: false }),
      scopePageSearch({ type: "screenshot", groupByPath: true }),
    ];
    for (const search of searches) {
      expect(filesRouteRedirect("acme", search)).toBeNull();
    }
  });
});

describe("pullsEmptyCopy", () => {
  it("names the 90-day window until older pull requests are shown", () => {
    expect(pullsEmptyCopy({ filtering: false, showOlder: false })).toEqual({
      kind: "command",
      title: "No pull request files in the last 90 days",
      description:
        "Files attached to a pull request show up here, newest first. Older pull requests are below.",
    });
    expect(pullsEmptyCopy({ filtering: true, showOlder: false })).toEqual({
      kind: "filtered",
      title: "No pull requests in the last 90 days match these filters.",
    });
  });

  it("keeps the onboarding and plain filtered copy once all=1 is on", () => {
    expect(pullsEmptyCopy({ filtering: false, showOlder: true })).toEqual({
      kind: "command",
      title: "No pull request files yet",
      description: "Files attached to a pull request show up here, newest first.",
    });
    expect(pullsEmptyCopy({ filtering: true, showOlder: true })).toEqual({
      kind: "filtered",
      title: "No pull requests match these filters.",
    });
  });
});
