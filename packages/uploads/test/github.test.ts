import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import {
  ATTACHMENTS_MARKER,
  attachmentsCommentBody,
  GH_PRIVATE_ROOT,
  ghAttachmentKey,
  ghBranchAttachmentKey,
  ghBranchKeyPrefix,
  ghKeyPrefix,
  ghMetadataForBranch,
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  ghPrivateBranchKeyPrefix,
  ghPrivateKeyPrefix,
  isValidRepo,
  normalizeGithubCoordinate,
  parseGhKey,
  parseGhPrivateKey,
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

describe("ghBranchKeyPrefix / ghBranchAttachmentKey", () => {
  it("builds the branch prefix", () => {
    expect(ghBranchKeyPrefix("buildinternet/uploads", "main")).toBe(
      "gh/buildinternet/uploads/branch/main/",
    );
  });
  it("sanitizes a branch name with slashes (e.g. feature/x -> feature-x)", () => {
    expect(ghBranchKeyPrefix("o/r", "feature/x")).toBe("gh/o/r/branch/feature-x/");
  });
  it("builds a stable key with no content hash, preserving branch case", () => {
    expect(ghBranchAttachmentKey("o/r", "Feature/X", "after.png")).toBe(
      "gh/o/r/branch/Feature-X/after.png",
    );
  });
  it("sanitizes filename characters", () => {
    expect(ghBranchAttachmentKey("o/r", "main", "my shot (1).png")).toBe(
      "gh/o/r/branch/main/my-shot--1-.png",
    );
  });
});

const PREFIX_ID = "0123456789abcdef0123456789abcdef";

describe("ghPrivateKeyPrefix / ghPrivateAttachmentKey", () => {
  const pr: GhTarget = { repo: "acme/web", kind: "pull", num: 12 };

  it("builds the PR prefix under gh/private/<id>/", () => {
    expect(ghPrivateKeyPrefix(PREFIX_ID, pr)).toBe(`gh/private/${PREFIX_ID}/pull/12/`);
  });
  it("builds the issue prefix", () => {
    expect(ghPrivateKeyPrefix(PREFIX_ID, { repo: "o/r", kind: "issues", num: 7 })).toBe(
      `gh/private/${PREFIX_ID}/issues/7/`,
    );
  });
  it("does not include the repo in the key (repo is unrecoverable from the key)", () => {
    expect(ghPrivateKeyPrefix(PREFIX_ID, pr)).not.toContain("acme");
    expect(ghPrivateKeyPrefix(PREFIX_ID, pr)).not.toContain("web");
  });
  it("builds a stable attachment key with no content hash", () => {
    expect(ghPrivateAttachmentKey(PREFIX_ID, pr, "after.png")).toBe(
      `gh/private/${PREFIX_ID}/pull/12/after.png`,
    );
  });
  it("sanitizes filename characters", () => {
    expect(ghPrivateAttachmentKey(PREFIX_ID, pr, "my shot (1).png")).toBe(
      `gh/private/${PREFIX_ID}/pull/12/my-shot--1-.png`,
    );
  });
  it("throws when prefixId fails the 32-lowercase-hex shape", () => {
    expect(() => ghPrivateKeyPrefix("not-hex", pr)).toThrow();
    expect(() => ghPrivateKeyPrefix(PREFIX_ID.toUpperCase(), pr)).toThrow();
    expect(() => ghPrivateKeyPrefix(PREFIX_ID.slice(0, 31), pr)).toThrow();
    expect(() => ghPrivateAttachmentKey("bad", pr, "x.png")).toThrow();
  });
  it("GH_PRIVATE_ROOT is the shared literal prefix", () => {
    expect(GH_PRIVATE_ROOT).toBe("gh/private/");
    expect(ghPrivateKeyPrefix(PREFIX_ID, pr).startsWith(GH_PRIVATE_ROOT)).toBe(true);
  });
});

describe("ghPrivateBranchKeyPrefix / ghPrivateBranchAttachmentKey", () => {
  it("builds the branch prefix with no branch-name segment", () => {
    expect(ghPrivateBranchKeyPrefix(PREFIX_ID)).toBe(`gh/private/${PREFIX_ID}/branch/`);
  });
  it("builds a stable branch attachment key", () => {
    expect(ghPrivateBranchAttachmentKey(PREFIX_ID, "after.png")).toBe(
      `gh/private/${PREFIX_ID}/branch/after.png`,
    );
  });
  it("sanitizes filename characters", () => {
    expect(ghPrivateBranchAttachmentKey(PREFIX_ID, "my shot (1).png")).toBe(
      `gh/private/${PREFIX_ID}/branch/my-shot--1-.png`,
    );
  });
  it("throws when prefixId fails the 32-lowercase-hex shape", () => {
    expect(() => ghPrivateBranchKeyPrefix("bad")).toThrow();
    expect(() => ghPrivateBranchAttachmentKey("bad", "x.png")).toThrow();
  });
});

describe("parseGhPrivateKey", () => {
  it("round-trips a PR key built by ghPrivateAttachmentKey", () => {
    const pr: GhTarget = { repo: "acme/web", kind: "pull", num: 12 };
    const key = ghPrivateAttachmentKey(PREFIX_ID, pr, "hero.png");
    expect(parseGhPrivateKey(key)).toEqual({ prefixId: PREFIX_ID, kind: "pull", num: 12 });
  });
  it("round-trips an issue key", () => {
    const key = `gh/private/${PREFIX_ID}/issues/42/screenshot.webp`;
    expect(parseGhPrivateKey(key)).toEqual({ prefixId: PREFIX_ID, kind: "issues", num: 42 });
  });
  it("returns undefined for a non-hex or wrong-length second segment", () => {
    expect(parseGhPrivateKey("gh/private/notHex/pull/5/x.png")).toBeUndefined();
    expect(parseGhPrivateKey(`gh/private/${PREFIX_ID.slice(0, 31)}/pull/5/x.png`)).toBeUndefined();
    expect(parseGhPrivateKey(`gh/private/${PREFIX_ID.toUpperCase()}/pull/5/x.png`)).toBeUndefined();
  });
  it("returns undefined for a non-private key", () => {
    expect(parseGhPrivateKey("gh/acme/web/pull/12/hero.png")).toBeUndefined();
  });
  it("returns undefined for a branch key (no PR/issue number)", () => {
    expect(parseGhPrivateKey(`gh/private/${PREFIX_ID}/branch/x.png`)).toBeUndefined();
  });
});

describe("parseGhKey with private-shape keys", () => {
  it("returns undefined for a key matching the strict private shape (32-hex id)", () => {
    expect(parseGhKey(`gh/private/${PREFIX_ID}/pull/5/x.png`)).toBeUndefined();
  });
  it("still parses a real owner literally named 'private' when the second segment is not 32-hex (accepted ambiguity)", () => {
    expect(parseGhKey("gh/private/realrepo/pull/5/x.png")).toEqual({
      repo: "private/realrepo",
      kind: "pull",
      num: 5,
    });
  });
});

describe("ghMetadataForBranch", () => {
  const now = new Date("2026-07-20T18:00:00.123Z");

  it("writes gh.repo/gh.kind=branch/gh.branch/gh.staged-at/gh.status (no gh.number/gh.ref/gh.title)", () => {
    expect(ghMetadataForBranch("BuildInternet/Uploads", "main", now)).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "branch",
      "gh.branch": "main",
      "gh.staged-at": "2026-07-20T18:00:00Z",
      "gh.status": "staged",
    });
  });

  it("lowercases gh.branch but preserves the key path's original case (handled separately by ghBranchAttachmentKey)", () => {
    const metadata = ghMetadataForBranch("o/r", "Feature/X", now);
    expect(metadata["gh.branch"]).toBe("feature/x");
  });

  it("drops the fractional seconds from gh.staged-at", () => {
    const metadata = ghMetadataForBranch("o/r", "main", now);
    expect(metadata["gh.staged-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("throws UsageError when the lowercased branch name fails the printable-ASCII metadata rule", () => {
    expect(() => ghMetadataForBranch("o/r", "feature/🚀", now)).toThrow(UsageError);
  });
});

describe("attachmentsCommentBody", () => {
  it("starts with the marker and renders images with a width cap, other files as a table (issue #946)", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/notes.txt", url: "https://x.test/gh/o/r/pull/1/notes.txt" },
      { key: "gh/o/r/pull/1/after.png", url: "https://x.test/gh/o/r/pull/1/after.png" },
    ]);
    expect(body.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(body).toContain(
      '<a href="https://x.test/gh/o/r/pull/1/after.png"><img width="720" alt="after.png" src="https://x.test/gh/o/r/pull/1/after.png"></a>',
    );
    expect(body).not.toContain("![after.png]");
    expect(body).toContain("| File | Type | Size |");
    expect(body).toContain("| [notes.txt](https://x.test/gh/o/r/pull/1/notes.txt) | TXT | — |");
    expect(body).toContain('<a href="https://uploads.sh">uploads.sh</a>');
  });

  it("renders pdf, json, and zip items as a file table, never as embeds or bullets (issue #946)", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/lighthouse.json", url: "https://x.test/lighthouse.json" },
      {
        key: "gh/o/r/pull/1/report.pdf",
        url: "https://x.test/report.pdf",
        pageUrl: "https://uploads.sh/f/w/report.pdf",
      },
      { key: "gh/o/r/pull/1/dist.zip", url: "https://x.test/dist.zip" },
    ]);
    expect(body).toContain("| [lighthouse.json](https://x.test/lighthouse.json) | JSON | — |");
    expect(body).toContain(
      "| [report.pdf](https://x.test/report.pdf) · [page](https://uploads.sh/f/w/report.pdf) | PDF | — |",
    );
    expect(body).toContain("| [dist.zip](https://x.test/dist.zip) | ZIP | — |");
    expect(body).not.toContain("- [lighthouse.json]");
    expect(body).not.toContain("<img");
  });

  it("uses a narrower width for phone-like filenames", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/demo-mobile-iphone.webp",
        url: "https://x.test/iphone.webp",
      },
    ]);
    expect(body).toContain(
      '<a href="https://x.test/iphone.webp"><img width="360" alt="demo-mobile-iphone.webp"',
    );
  });

  it("uses a wider width for browser-like filenames", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/demo-web-browser.webp", url: "https://x.test/browser.webp" },
    ]);
    expect(body).toContain(
      '<a href="https://x.test/browser.webp"><img width="800" alt="demo-web-browser.webp"',
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

  it("lists items without a url as a plain, unlinked table row", () => {
    const body = attachmentsCommentBody([{ key: "gh/o/r/pull/1/x.bin", url: null }]);
    expect(body).toContain("| x.bin | BIN | — |");
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
    expect(body).not.toContain("Attachments");
  });

  it("renders up to three inline previews that link back to the gallery", () => {
    const body = attachmentsCommentBody(
      [],
      [
        {
          title: "Release screenshots",
          url: "https://uploads.test/g/gal_release",
          previews: [
            {
              url: "https://storage.test/one.webp",
              alt: "First screen",
              itemUrl: "https://uploads.test/g/gal_release/item-1",
            },
            { url: "https://storage.test/two.webp", alt: "Second screen" },
            { url: "https://storage.test/three.webp", alt: "Third screen" },
          ],
        },
      ],
    );
    expect(body).toContain(
      '<a href="https://uploads.test/g/gal_release/item-1"><img width="320" alt="First screen" src="https://storage.test/one.webp"></a>',
    );
    expect(body).toContain(
      '<a href="https://uploads.test/g/gal_release"><img width="320" alt="Second screen" src="https://storage.test/two.webp"></a>',
    );
    expect(body).toContain("Open gallery");
  });

  it("keeps galleries and loose attachments in clearly separate sections", () => {
    const body = attachmentsCommentBody(
      [{ key: "gh/o/r/pull/1/after.png", url: "https://x.test/after.png" }],
      [{ title: "Release screenshots", url: "https://uploads.test/g/gal_release" }],
    );
    expect(body.indexOf("### 🖼️ Galleries")).toBeLessThan(body.indexOf("after.png"));
    expect(body).toContain("Release screenshots");
    expect(body).toContain("after.png");
  });

  it("uses embedUrl for image src while linking to the stable url", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/shot.webp",
        url: "https://storage.uploads.sh/default/gh/o/r/pull/1/shot.webp",
        embedUrl: "https://embed.uploads.sh/default/gh/o/r/pull/1/shot.webp",
      },
    ]);
    expect(body).toContain('src="https://embed.uploads.sh/default/gh/o/r/pull/1/shot.webp"');
    expect(body).toContain('href="https://storage.uploads.sh/default/gh/o/r/pull/1/shot.webp"');
  });

  it("renders the empty body without either content section", () => {
    const body = attachmentsCommentBody([], []);
    expect(body).toContain(ATTACHMENTS_MARKER);
    expect(body).not.toContain("### 🖼️ Galleries");
    expect(body).toContain("_No attachments are currently associated with this pull request._");
  });

  it("links an image to its pageUrl (not raw url) when present", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/after.png",
        url: "https://x.test/after.png",
        embedUrl: "https://embed.test/after.png",
        pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/after.png",
      },
    ]);
    expect(body).toContain(
      '<a href="https://uploads.sh/f/ws/gh/o/r/pull/1/after.png"><img width="720" alt="after.png" src="https://embed.test/after.png"></a>',
    );
  });

  it("links a non-image attachment to its pageUrl when present", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/demo.mp4",
        url: "https://x.test/demo.mp4",
        pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/demo.mp4",
      },
    ]);
    expect(body).toContain("- [demo.mp4](https://uploads.sh/f/ws/gh/o/r/pull/1/demo.mp4)");
  });

  it("falls back to the raw url for the href when pageUrl is absent", () => {
    const body = attachmentsCommentBody([
      { key: "gh/o/r/pull/1/after.png", url: "https://x.test/after.png" },
    ]);
    expect(body).toContain('<a href="https://x.test/after.png"><img');
  });

  it("suppresses a bare / path caption (issue #375)", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/o/r/pull/1/home.webp",
        url: "https://x.test/home.webp",
        embedUrl: "https://embed.test/home.webp",
        meta: { path: "/" },
      },
      {
        key: "gh/o/r/pull/1/home-before.webp",
        url: "https://x.test/home-before.webp",
        embedUrl: "https://embed.test/home-before.webp",
        meta: { path: "/", state: "before" },
      },
    ]);
    expect(body).not.toContain("<code>/</code>");
    expect(body).not.toContain("/ · before");
    expect(body).toContain("<code>before</code>");
  });
});
