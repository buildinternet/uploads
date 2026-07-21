import { describe, expect, it } from "vitest";
import type { MyWorkspace, WorkspacesResult } from "./api-client";
import {
  breadcrumbSegments,
  childName,
  chipKind,
  fileTypeLabel,
  isPrivateFile,
  leafName,
  pickThumbnail,
  resolveWorkspaceInfo,
} from "./workspace-file-row";

describe("pickThumbnail", () => {
  it("renders a real thumbnail for an image with an embedUrl", () => {
    expect(
      pickThumbnail({
        contentType: "image/png",
        url: "https://s/x.png",
        embedUrl: "https://e/x.png",
      }),
    ).toEqual({ kind: "image", src: "https://e/x.png" });
  });

  it("falls back to a lock tile for an image with no url at all (private/unconfigured)", () => {
    expect(pickThumbnail({ contentType: "image/png", url: null, embedUrl: null })).toEqual({
      kind: "lock",
    });
  });

  it("renders no tile for an image with a url but no embed twin (e.g. BYO domain)", () => {
    expect(
      pickThumbnail({
        contentType: "image/png",
        url: "https://custom.example/x.png",
        embedUrl: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("renders a play-glyph tile for video regardless of url/embedUrl", () => {
    expect(pickThumbnail({ contentType: "video/mp4", url: null, embedUrl: null })).toEqual({
      kind: "video",
    });
  });

  it("renders no tile for a non-image/video file", () => {
    expect(
      pickThumbnail({
        contentType: "application/pdf",
        url: "https://s/x.pdf",
        embedUrl: "https://e/x.pdf",
      }),
    ).toEqual({ kind: "none" });
  });

  it("renders no tile for an unsupported image type (svg)", () => {
    expect(
      pickThumbnail({
        contentType: "image/svg+xml",
        url: "https://s/x.svg",
        embedUrl: "https://e/x.svg",
      }),
    ).toEqual({ kind: "none" });
  });

  it("treats a missing contentType as a plain file (no tile)", () => {
    expect(pickThumbnail({ url: "https://s/x", embedUrl: "https://e/x" })).toEqual({
      kind: "none",
    });
  });
});

describe("chipKind", () => {
  it("maps gh.repo to the repo (GitHub mark) chip", () => {
    expect(chipKind("gh.repo")).toBe("repo");
  });
  it("maps gh.number to the pr (PR glyph) chip", () => {
    expect(chipKind("gh.number")).toBe("pr");
  });
  it("maps any other key to a plain key=value chip", () => {
    expect(chipKind("app")).toBe("plain");
    expect(chipKind("gh.kind")).toBe("plain");
    expect(chipKind("gh.ref")).toBe("plain");
  });
});

describe("fileTypeLabel", () => {
  it("derives a short label from the MIME subtype", () => {
    expect(fileTypeLabel({ contentType: "image/png", key: "x.png" })).toBe("png");
    expect(fileTypeLabel({ contentType: "video/mp4", key: "x.mp4" })).toBe("mp4");
  });
  it("strips a +suffix from the subtype", () => {
    expect(fileTypeLabel({ contentType: "image/svg+xml", key: "x.svg" })).toBe("svg");
  });
  it("strips a charset parameter before parsing", () => {
    expect(fileTypeLabel({ contentType: "text/plain; charset=utf-8", key: "x.txt" })).toBe("plain");
  });
  it("falls back to the key's extension when contentType is absent", () => {
    expect(fileTypeLabel({ key: "screenshots/x.PDF" })).toBe("pdf");
  });
  it("falls back to 'file' when neither is available", () => {
    expect(fileTypeLabel({ key: "no-extension" })).toBe("file");
  });
});

describe("childName", () => {
  it("strips a matching prefix from a file key", () => {
    expect(childName("f/x.png", "f/")).toBe("x.png");
  });
  it("strips a matching prefix and trailing slash from a folder path", () => {
    expect(childName("screenshots/releases/", "screenshots/")).toBe("releases");
  });
  it("falls back to the full key when it doesn't start with prefix", () => {
    expect(childName("f/x.png", "other/")).toBe("f/x.png");
  });
  it("handles the root prefix (empty string)", () => {
    expect(childName("x.png", "")).toBe("x.png");
  });
});

describe("leafName", () => {
  it("returns the last path segment of a nested key", () => {
    expect(leafName("screenshots/either/280/demographics.png")).toBe("demographics.png");
  });
  it("returns the key itself when it has no folder", () => {
    expect(leafName("solo.png")).toBe("solo.png");
  });
  it("ignores a trailing slash (folder-style key)", () => {
    expect(leafName("screenshots/either/")).toBe("either");
  });
  it("falls back to the full key when empty", () => {
    expect(leafName("")).toBe("");
  });
});

describe("breadcrumbSegments", () => {
  it("returns no segments for the root", () => {
    expect(breadcrumbSegments("")).toEqual([]);
  });
  it("builds cumulative prefixes for a nested path", () => {
    expect(breadcrumbSegments("screenshots/releases/1789/")).toEqual([
      { label: "screenshots", prefix: "screenshots/" },
      { label: "releases", prefix: "screenshots/releases/" },
      { label: "1789", prefix: "screenshots/releases/1789/" },
    ]);
  });
  it("tolerates a path with no trailing slash", () => {
    expect(breadcrumbSegments("a/b")).toEqual([
      { label: "a", prefix: "a/" },
      { label: "b", prefix: "a/b/" },
    ]);
  });
});

describe("isPrivateFile", () => {
  it("is true only for explicit private visibility", () => {
    expect(isPrivateFile({ visibility: "private" })).toBe(true);
  });
  it("defaults to public (false) for public or missing visibility", () => {
    expect(isPrivateFile({ visibility: "public" })).toBe(false);
    expect(isPrivateFile({})).toBe(false);
  });
});

/** Test fixture for a `MyWorkspace` entry — only the fields the `it()`s below vary need overriding. */
function mkWorkspace(workspace: string, overrides: Partial<MyWorkspace> = {}): MyWorkspace {
  return {
    workspace,
    organization: { id: "1", slug: workspace, name: workspace },
    role: "member",
    hasPublicUrl: false,
    ...overrides,
  };
}

describe("resolveWorkspaceInfo", () => {
  it("maps a non-success getMyWorkspaces result to 'unavailable' (API outage, not an empty listing)", () => {
    const result: WorkspacesResult = { kind: "unavailable", reason: "server" };
    expect(resolveWorkspaceInfo(result, "acme")).toEqual({ status: "unavailable" });
  });

  it("maps a success result missing the requested workspace to 'no-access' (lost access / stale slug)", () => {
    const result: WorkspacesResult = { kind: "success", workspaces: [mkWorkspace("other")] };
    expect(resolveWorkspaceInfo(result, "acme")).toEqual({ status: "no-access" });
  });

  it("maps a success result containing the workspace to 'ready', passing through hasPublicUrl", () => {
    const result: WorkspacesResult = {
      kind: "success",
      workspaces: [mkWorkspace("acme", { role: "admin", hasPublicUrl: true })],
    };
    expect(resolveWorkspaceInfo(result, "acme")).toEqual({
      status: "ready",
      hasPublicUrl: true,
    });
  });

  it("resolves a workspace named 'default' to 'ready' just like any other workspace", () => {
    const result: WorkspacesResult = {
      kind: "success",
      workspaces: [mkWorkspace("default")],
    };
    expect(resolveWorkspaceInfo(result, "default")).toEqual({
      status: "ready",
      hasPublicUrl: false,
    });
  });
});
