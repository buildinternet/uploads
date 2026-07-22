import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentsCommentBody } from "../src/github.js";

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url)), "utf8"),
  ) as { items: any[]; galleries: any[]; marker?: string; expected: string };
}

const golden = loadFixture("github-comment-golden.json");
const goldenCap = loadFixture("github-comment-golden-cap.json");
const goldenMeta = loadFixture("github-comment-golden-meta.json");
const goldenVideo = loadFixture("github-comment-golden-video.json");

describe("attachmentsCommentBody (CLI copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
  });

  it("renders a video with a poster as a linked image with a play caption", () => {
    expect(attachmentsCommentBody(goldenVideo.items, goldenVideo.galleries)).toBe(
      goldenVideo.expected,
    );
  });

  it("falls back to a bullet link when a video has no poster", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/acme/web/pull/12/demo.mp4",
        url: "https://uploads.sh/f/demo.mp4",
        embedUrl: null,
        pageUrl: "https://uploads.sh/f/acme/demo.mp4",
      },
    ]);
    expect(body).toContain("- [demo.mp4](https://uploads.sh/f/acme/demo.mp4)");
    expect(body).not.toContain("<img");
  });

  it("composes the play caption with path/state metadata", () => {
    const body = attachmentsCommentBody([
      {
        key: "gh/acme/web/pull/12/demo.mp4",
        url: "https://uploads.sh/f/demo.mp4",
        embedUrl: null,
        pageUrl: "https://uploads.sh/f/acme/demo.mp4",
        posterUrl: "https://embed.uploads.sh/_internal/posters/demo.mp4.jpg",
        videoMeta: { durationSeconds: 14, width: 1920, height: 1080 },
        meta: { path: "src/app", state: "after" },
      },
    ]);
    expect(body).toContain("<sub>▶ Play video · 0:14 · src/app · after</sub>");
  });

  it("caps inline images at 16, collapsing the rest into a details block", () => {
    expect(attachmentsCommentBody(goldenCap.items, goldenCap.galleries, goldenCap.marker)).toBe(
      goldenCap.expected,
    );
  });

  it("renders path/state captions, and nothing when they are absent", () => {
    expect(attachmentsCommentBody(goldenMeta.items, goldenMeta.galleries)).toBe(
      goldenMeta.expected,
    );
  });

  it("captions overflow rows and escapes markdown metacharacters", () => {
    // 18 images exceeds MAX_INLINE_ATTACHMENT_IMAGES (16), so the last two
    // collapse into the <details> list — those rows must caption too.
    const items = Array.from({ length: 18 }, (_, i) => ({
      key: `gh/acme/web/pull/12/shot-${String(i).padStart(2, "0")}.png`,
      url: `https://uploads.sh/f/shot-${i}.png`,
      embedUrl: `https://embed.uploads.sh/f/shot-${i}.png`,
      pageUrl: `https://uploads.sh/f/acme/shot-${i}.png`,
      // Tildes included: GitHub strikes through text wrapped in a matching pair
      // of one or two tildes, so `~e~` would render struck through unescaped.
      meta: { path: "/a_b[c]*d~e~", state: "after" },
    }));

    const body = attachmentsCommentBody(items);

    // Markdown context: the metacharacters are backslash-escaped.
    expect(body).toContain(
      "- [shot-17.png](https://uploads.sh/f/acme/shot-17.png) · /a\\_b\\[c\\]\\*d\\~e\\~ · after",
    );
    // HTML context: <sub> needs no markdown escaping, so the value is verbatim.
    expect(body).toContain("<sub>/a_b[c]*d~e~ · after</sub>");
  });
});
