import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_MARKER,
  attachmentsCommentBody,
  ghAttachmentKey,
  ghKeyPrefix,
  isValidRepo,
  parseRepoFromRemoteUrl,
  type GhTarget,
} from "../src/github.js";

describe("isValidRepo", () => {
  it("accepts owner/name", () => {
    expect(isValidRepo("buildinternet/uploads")).toBe(true);
    expect(isValidRepo("a-b.c/d_e")).toBe(true);
  });
  it("rejects bare names and junk", () => {
    expect(isValidRepo("uploads")).toBe(false);
    expect(isValidRepo("a/b/c")).toBe(false);
    expect(isValidRepo("")).toBe(false);
    expect(isValidRepo("owner/")).toBe(false);
  });
});

describe("parseRepoFromRemoteUrl", () => {
  it("parses SSH remotes", () => {
    expect(parseRepoFromRemoteUrl("git@github.com:buildinternet/uploads.git")).toBe(
      "buildinternet/uploads",
    );
  });
  it("parses HTTPS remotes with and without .git", () => {
    expect(parseRepoFromRemoteUrl("https://github.com/buildinternet/uploads.git")).toBe(
      "buildinternet/uploads",
    );
    expect(parseRepoFromRemoteUrl("https://github.com/buildinternet/uploads")).toBe(
      "buildinternet/uploads",
    );
  });
  it("returns undefined for junk", () => {
    expect(parseRepoFromRemoteUrl("not a url")).toBeUndefined();
    expect(parseRepoFromRemoteUrl("")).toBeUndefined();
  });
});

describe("ghKeyPrefix / ghAttachmentKey", () => {
  const pr: GhTarget = { repo: "buildinternet/uploads", kind: "pull", num: 123 };

  it("builds the PR prefix", () => {
    expect(ghKeyPrefix(pr)).toBe("gh/buildinternet/uploads/pull/123/");
  });
  it("builds the issue prefix", () => {
    expect(ghKeyPrefix({ repo: "o/r", kind: "issues", num: 7 })).toBe("gh/o/r/issues/7/");
  });
  it("builds a stable key with no content hash", () => {
    expect(ghAttachmentKey(pr, "after.png")).toBe("gh/buildinternet/uploads/pull/123/after.png");
  });
  it("sanitizes filename characters", () => {
    expect(ghAttachmentKey(pr, "my shot (1).png")).toBe(
      "gh/buildinternet/uploads/pull/123/my-shot--1-.png",
    );
  });
});

describe("attachmentsCommentBody", () => {
  it("starts with the marker and renders images with a width cap, other files as links", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/notes.txt", url: "https://x.test/gh/o/r/pull/1/notes.txt" },
      { key: "gh/o/r/pull/1/after.png", url: "https://x.test/gh/o/r/pull/1/after.png" },
    ]);
    expect(body.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(body).toContain(
      '<img width="400" alt="after.png" src="https://x.test/gh/o/r/pull/1/after.png">',
    );
    expect(body).not.toContain("![after.png]");
    expect(body).toContain("- [notes.txt](https://x.test/gh/o/r/pull/1/notes.txt)");
    expect(body).toContain('<a href="https://uploads.sh">uploads.sh</a>');
  });

  it("uses a narrower width for phone-like filenames", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/demo-mobile-iphone.webp",
        url: "https://x.test/iphone.webp",
      },
    ]);
    expect(body).toContain('<img width="280" alt="demo-mobile-iphone.webp"');
  });

  it("uses a wider width for browser-like filenames", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/demo-web-browser.webp", url: "https://x.test/browser.webp" },
    ]);
    expect(body).toContain('<img width="640" alt="demo-web-browser.webp"');
  });

  it("sorts deterministically by key so repeated runs produce identical bodies", () => {
    const a = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/b.png", url: "https://x/b.png" },
      { key: "gh/o/r/pull/1/a.png", url: "https://x/a.png" },
    ]);
    const b = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/a.png", url: "https://x/a.png" },
      { key: "gh/o/r/pull/1/b.png", url: "https://x/b.png" },
    ]);
    expect(a).toBe(b);
    expect(a.indexOf("a.png")).toBeLessThan(a.indexOf("b.png"));
  });

  it("lists items without a url as plain names", () => {
    const body = attachmentsCommentBody([{ key: "gh/o/r/pull/1/x.bin", url: null }]);
    expect(body).toContain("- x.bin");
  });
});
