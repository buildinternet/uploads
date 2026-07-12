import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_MARKER,
  attachmentsCommentBody,
  ghAttachmentKey,
  ghKeyPrefix,
  isValidRepo,
  normalizeGithubCoordinate,
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

describe("normalizeGithubCoordinate", () => {
  it("normalizes owner/repo coordinates and strict GitHub issue or pull URLs", () => {
    expect(normalizeGithubCoordinate("BuildInternet/Uploads#58")).toMatchObject({
      coordinate: "buildinternet/uploads#58",
    });
    expect(
      normalizeGithubCoordinate("https://github.com/BuildInternet/Uploads/pull/58"),
    ).toMatchObject({
      coordinate: "buildinternet/uploads#58",
      canonicalUrl: "https://github.com/buildinternet/uploads/issues/58",
    });
  });
  it.each([
    "http://github.com/o/r/issues/1",
    "https://github.com/o/r/issues/1?x=1",
    "https://github.com/o/r/pulls/1",
    "https://evil.example/o/r/issues/1",
  ])("rejects non-canonical GitHub URLs: %s", (value) => {
    expect(normalizeGithubCoordinate(value)).toBeUndefined();
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
      '<a href="https://x.test/gh/o/r/pull/1/after.png"><img width="400" alt="after.png" src="https://x.test/gh/o/r/pull/1/after.png"></a>',
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
    expect(body).toContain(
      '<a href="https://x.test/iphone.webp"><img width="280" alt="demo-mobile-iphone.webp"',
    );
  });

  it("uses a wider width for browser-like filenames", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/demo-web-browser.webp", url: "https://x.test/browser.webp" },
    ]);
    expect(body).toContain(
      '<a href="https://x.test/browser.webp"><img width="640" alt="demo-web-browser.webp"',
    );
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

  it("renders a distinct, safely escaped Galleries section without attachments", () => {
    const body = attachmentsCommentBody(
      [],
      [{ title: `A <gallery> & "quotes"`, url: "https://uploads.test/g/gal_a?x=1&y=2" }],
    );
    expect(body).toContain("### 🖼️ Galleries");
    expect(body).toContain(
      `<a href="https://uploads.test/g/gal_a?x=1&amp;y=2">A &lt;gallery&gt; &amp; &quot;quotes&quot;</a>`,
    );
    expect(body).not.toContain("### 📎 Attachments");
  });

  it("renders up to three inline previews that link back to the gallery", () => {
    const body = attachmentsCommentBody(
      [],
      [
        {
          title: "Release screenshots",
          url: "https://uploads.test/g/gal_release",
          previews: [
            { url: "https://storage.test/one.webp", alt: "First screen" },
            { url: "https://storage.test/two.webp", alt: "Second screen" },
            { url: "https://storage.test/three.webp", alt: "Third screen" },
          ],
        },
      ],
    );
    expect(body).toContain(
      '<a href="https://uploads.test/g/gal_release"><img width="320" alt="First screen" src="https://storage.test/one.webp"></a>',
    );
    expect(body).toContain("Open gallery");
  });

  it("keeps galleries and loose attachments in clearly separate sections", () => {
    const body = attachmentsCommentBody(
      [{ key: "gh/o/r/pull/1/after.png", url: "https://x.test/after.png" }],
      [{ title: "Release screenshots", url: "https://uploads.test/g/gal_release" }],
    );
    expect(body.indexOf("### 🖼️ Galleries")).toBeLessThan(body.indexOf("### 📎 Attachments"));
    expect(body).toContain("Release screenshots");
    expect(body).toContain("after.png");
  });

  it("renders the empty body without either content section", () => {
    const body = attachmentsCommentBody([], []);
    expect(body).toContain(ATTACHMENTS_MARKER);
    expect(body).not.toContain("### 🖼️ Galleries");
    expect(body).toContain("### 📎 Attachments");
  });
});
