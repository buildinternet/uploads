import { describe, expect, it } from "vitest";
import {
  filesRouteRedirect,
  isBucketBrowseSearch,
  legacyWorkspaceRedirect,
  type LegacyWorkspaceRoute,
} from "./workspace-route-redirects";

const B = "/account/workspaces/acme";

describe("isBucketBrowseSearch", () => {
  it("recognizes every old bucket-browser deep-link key", () => {
    expect(isBucketBrowseSearch("?path=a/")).toBe(true);
    expect(isBucketBrowseSearch("?prefix=a/")).toBe(true);
    expect(isBucketBrowseSearch("?name=hero")).toBe(true);
    expect(isBucketBrowseSearch("?meta.app=web")).toBe(true);
    expect(isBucketBrowseSearch("?view=list")).toBe(true);
    expect(isBucketBrowseSearch("?view=grid")).toBe(true);
  });

  it("ignores Files and By page params", () => {
    expect(isBucketBrowseSearch("")).toBe(false);
    expect(isBucketBrowseSearch("?view=pages")).toBe(false);
    expect(isBucketBrowseSearch("?view=recent")).toBe(false);
    expect(isBucketBrowseSearch("?project=acme%2Fweb&q=%2Fcat&merged=1")).toBe(false);
  });
});

describe("filesRouteRedirect", () => {
  it.each([
    ["?prefix=a/b/", `${B}/storage?prefix=a/b/`],
    ["?path=screenshots/releases/", `${B}/storage?path=screenshots/releases/`],
    ["?name=hero", `${B}/storage?name=hero`],
    ["?meta.gh.repo=acme/web&meta.app=web", `${B}/storage?meta.gh.repo=acme/web&meta.app=web`],
    ["?view=grid", `${B}/storage?view=grid`],
    ["?view=list&path=a/", `${B}/storage?view=list&path=a/`],
    ["path=a/", `${B}/storage?path=a/`],
  ])("sends the old bucket-browser link %s to Storage", (search, target) => {
    expect(filesRouteRedirect("acme", search)).toBe(target);
  });

  it.each([
    "",
    "?",
    "?view=pages",
    "?view=repos",
    "?view=pages&path=%2Fsettings",
    "?view=pages&sort=recent",
    "?project=acme%2Fweb",
    "?view=recent",
  ])("keeps %s on Files", (search) => {
    expect(filesRouteRedirect("acme", search)).toBeNull();
  });
});

describe("legacyWorkspaceRedirect", () => {
  const rows: Array<[LegacyWorkspaceRoute, string, string]> = [
    ["screenshots", "", `${B}/files?view=pages`],
    ["screenshots", "?view=recent", `${B}/files?view=pages&sort=recent`],
    [
      "screenshots",
      "?project=acme%2Fweb&path=%2Fadmin",
      `${B}/files?view=pages&project=acme%2Fweb&path=%2Fadmin`,
    ],
    ["screenshots", "?view=recent&merged=1", `${B}/files?view=pages&sort=recent&merged=1`],
    ["galleries", "", `${B}/links`],
    ["galleries", "?view=list", `${B}/links?view=list`],
    ["settings-storage", "", `${B}/storage#bucket`],
    ["settings-storage", "?x=1", `${B}/storage?x=1#bucket`],
    ["root", "", `${B}/files`],
    ["root", "?project=acme", `${B}/files?project=acme`],
    ["root", "?view=repos", `${B}/files?view=repos`],
    ["root", "?view=pages&path=%2Fsettings", `${B}/files?view=pages&path=%2Fsettings`],
    ["root", "?path=a/", `${B}/storage?path=a/`],
    ["root", "?prefix=a/b/", `${B}/storage?prefix=a/b/`],
    ["root", "?meta.app=web", `${B}/storage?meta.app=web`],
    ["root", "?name=hero", `${B}/storage?name=hero`],
    ["root", "?view=grid", `${B}/storage?view=grid`],
  ];

  it.each(rows)("%s with %j goes to %s", (route, search, target) => {
    expect(legacyWorkspaceRedirect(route, "acme", search)).toBe(target);
  });

  it("encodes the workspace slug", () => {
    expect(legacyWorkspaceRedirect("galleries", "a b", "")).toBe("/account/workspaces/a%20b/links");
  });
});
