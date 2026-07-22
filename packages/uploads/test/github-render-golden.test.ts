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
const goldenEmpty = loadFixture("github-comment-golden-empty.json");

describe("attachmentsCommentBody (CLI copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
  });

  it("renders a neutral empty state when there are no items or galleries", () => {
    expect(attachmentsCommentBody(goldenEmpty.items, goldenEmpty.galleries)).toBe(
      goldenEmpty.expected,
    );
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

  describe("before/after pairing (issue #419)", () => {
    const img = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      url: `https://uploads.sh/f/${key}`,
      embedUrl: `https://embed.uploads.sh/f/${key}`,
      pageUrl: `https://uploads.sh/f/acme/${key}`,
      ...extra,
    });

    it("pairs same-path before/after metadata into one side-by-side row", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/a.webp", { meta: { path: "/settings", state: "after" } }),
        img("gh/acme/web/pull/12/b.webp", { meta: { path: "/settings", state: "before" } }),
      ]);
      expect(body).toContain("<table><tr>");
      expect(body).toContain("<strong>Before</strong>");
      expect(body).toContain("<strong>After</strong>");
      // Before cell comes first regardless of which key sorts first.
      const beforeIdx = body.indexOf("b.webp");
      const afterIdx = body.indexOf("a.webp");
      expect(beforeIdx).toBeGreaterThan(-1);
      expect(beforeIdx).toBeLessThan(afterIdx);
      // Each side's own path/state caption is preserved.
      expect(body).toContain("/settings · before");
      expect(body).toContain("/settings · after");
      // Only one table row — no leftover standalone <img> rendering for these two.
      expect(body.match(/<table>/g)).toHaveLength(1);
    });

    it("falls back to filename-stem pairing when there is no path metadata", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/hero-after.webp"),
        img("gh/acme/web/pull/12/hero-before.webp"),
      ]);
      expect(body).toContain("<table><tr>");
      const beforeIdx = body.indexOf("hero-before.webp");
      const afterIdx = body.indexOf("hero-after.webp");
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it("pairs a bare before.png/after.png filename stem", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/after.png"),
        img("gh/acme/web/pull/12/before.png"),
      ]);
      expect(body).toContain("<table><tr>");
    });

    it("does not pair mismatched extensions or unrelated stems", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/hero-before.webp"),
        img("gh/acme/web/pull/12/hero-after.png"),
      ]);
      expect(body).not.toContain("<table>");
    });

    it("pairs a delimiter-bounded before/after token in the middle of the stem", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/paired-view-after-desktop.webp"),
        img("gh/acme/web/pull/12/paired-view-before-desktop.webp"),
      ]);
      const beforeIdx = body.indexOf("paired-view-before-desktop.webp");
      const afterIdx = body.indexOf("paired-view-after-desktop.webp");
      expect(beforeIdx).toBeGreaterThan(-1);
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it("does not treat 'before'/'after' as a token when not delimiter-bounded", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/beforehand.webp"),
        img("gh/acme/web/pull/12/aftermath.webp"),
      ]);
      expect(body).not.toContain("<table>");
    });

    it("leaves an unpaired attachment (including error/loading state) rendered as today", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/lonely-before.webp"),
        img("gh/acme/web/pull/12/other.webp", { meta: { path: "/x", state: "loading" } }),
      ]);
      expect(body).not.toContain("<table>");
      expect(body).toContain("lonely-before.webp");
      expect(body).toContain("other.webp");
      expect(body).toContain("/x · loading");
    });

    it("does not pair an ambiguous group (two befores for the same path)", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/a.webp", { meta: { path: "/x", state: "before" } }),
        img("gh/acme/web/pull/12/b.webp", { meta: { path: "/x", state: "before" } }),
        img("gh/acme/web/pull/12/c.webp", { meta: { path: "/x", state: "after" } }),
      ]);
      expect(body).not.toContain("<table>");
    });

    it("mixes a pair with other unrelated attachments, keeping sorted-key order", () => {
      const body = attachmentsCommentBody([
        img("gh/acme/web/pull/12/aaa-solo.webp"),
        img("gh/acme/web/pull/12/mid-after.webp"),
        img("gh/acme/web/pull/12/mid-before.webp"),
        img("gh/acme/web/pull/12/zzz-solo.webp"),
      ]);
      const soloIdx = body.indexOf("aaa-solo.webp");
      const tableIdx = body.indexOf("<table>");
      const zzzIdx = body.indexOf("zzz-solo.webp");
      expect(soloIdx).toBeLessThan(tableIdx);
      expect(tableIdx).toBeLessThan(zzzIdx);
      expect(body.match(/<table>/g)).toHaveLength(1);
    });

    it("keeps pairing stable across a re-upload of one side (same filename key)", () => {
      const first = attachmentsCommentBody([
        img("gh/acme/web/pull/12/hero-before.webp"),
        img("gh/acme/web/pull/12/hero-after.webp"),
      ]);
      // Re-capture of the "after" side updates its URL but keeps the same key.
      const second = attachmentsCommentBody([
        img("gh/acme/web/pull/12/hero-before.webp"),
        img("gh/acme/web/pull/12/hero-after.webp", {
          url: "https://uploads.sh/f/hero-after-v2.webp",
          embedUrl: "https://embed.uploads.sh/f/hero-after-v2.webp",
        }),
      ]);
      expect(first).toContain("<table>");
      expect(second).toContain("<table>");
      expect(second).toContain("hero-after-v2.webp");
    });

    it("does not pair a video poster with an image, even with a matching state", () => {
      const body = attachmentsCommentBody([
        {
          key: "gh/acme/web/pull/12/demo.mp4",
          url: "https://uploads.sh/f/demo.mp4",
          embedUrl: null,
          pageUrl: "https://uploads.sh/f/acme/demo.mp4",
          posterUrl: "https://embed.uploads.sh/_internal/posters/demo.mp4.jpg",
          meta: { path: "/x", state: "before" },
        },
        img("gh/acme/web/pull/12/shot.webp", { meta: { path: "/x", state: "after" } }),
      ]);
      expect(body).not.toContain("<table>");
    });
  });
});
