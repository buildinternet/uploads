import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attachmentDensityForCount,
  attachmentImageWidth,
  attachmentPairWidth,
  attachmentsCommentBody,
  AUTO_RENDER_OPTIONS,
  GH_PRIVATE_ROOT,
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  ghPrivateBranchKeyPrefix,
  ghPrivateKeyPrefix,
  parseGhPrivateKey,
  type AttachmentItem,
  type CommentRenderOptions,
  type GhTarget,
} from "../src/github.js";

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url)), "utf8"),
  ) as { items: any[]; galleries: any[]; marker?: string; expected: string };
}

interface PrivateKeyGolden {
  prefixId: string;
  keyCases: { target: GhTarget; filename: string; expectedPrefix: string; expectedKey: string }[];
  branchCases: { filename: string; expectedPrefix: string; expectedKey: string }[];
  parseCases: { key: string; expected: { prefixId: string; kind: string; num: number } }[];
  parseInvalidKeys: string[];
  invalidPrefixIds: string[];
}

function loadPrivateKeyFixture(name: string): PrivateKeyGolden {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url)), "utf8"),
  ) as PrivateKeyGolden;
}

function loadOptionsFixture(name: string) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url)), "utf8"),
  ) as {
    cases: {
      name: string;
      options: Partial<CommentRenderOptions>;
      expected: string;
      // Falls back to the golden suite's shared `items` when a case doesn't
      // need its own (most cases don't touch item count/meta).
      items?: AttachmentItem[];
    }[];
  };
}

const golden = loadFixture("github-comment-golden.json");
const goldenCap = loadFixture("github-comment-golden-cap.json");
const goldenMeta = loadFixture("github-comment-golden-meta.json");
const goldenVideo = loadFixture("github-comment-golden-video.json");
const goldenEmpty = loadFixture("github-comment-golden-empty.json");
const goldenOptions = loadOptionsFixture("github-comment-golden-options.json");
const goldenPrivateKeys = loadPrivateKeyFixture("github-comment-golden-private-keys.json");

describe("private-repo key builders/parsers (CLI copy) — golden parity fixture", () => {
  const { prefixId } = goldenPrivateKeys;

  it.each(goldenPrivateKeys.keyCases)(
    "builds the prefix and attachment key for $target.kind/$target.num",
    (c) => {
      expect(ghPrivateKeyPrefix(prefixId, c.target)).toBe(c.expectedPrefix);
      expect(ghPrivateAttachmentKey(prefixId, c.target, c.filename)).toBe(c.expectedKey);
    },
  );

  it.each(goldenPrivateKeys.branchCases)("builds the branch prefix and attachment key", (c) => {
    expect(ghPrivateBranchKeyPrefix(prefixId)).toBe(c.expectedPrefix);
    expect(ghPrivateBranchAttachmentKey(prefixId, c.filename)).toBe(c.expectedKey);
  });

  it.each(goldenPrivateKeys.parseCases)("round-trips $key via parseGhPrivateKey", (c) => {
    expect(parseGhPrivateKey(c.key)).toEqual(c.expected);
  });

  it.each(goldenPrivateKeys.parseInvalidKeys)(
    "parseGhPrivateKey returns undefined for %s",
    (key) => {
      expect(parseGhPrivateKey(key)).toBeUndefined();
    },
  );

  it.each(goldenPrivateKeys.invalidPrefixIds)("rejects a malformed prefixId %s", (badId) => {
    const target: GhTarget = { repo: "acme/web", kind: "pull", num: 1 };
    expect(() => ghPrivateKeyPrefix(badId, target)).toThrow();
    expect(() => ghPrivateBranchKeyPrefix(badId)).toThrow();
  });

  it("GH_PRIVATE_ROOT matches the fixture's literal prefix", () => {
    expect(GH_PRIVATE_ROOT).toBe("gh/private/");
  });
});

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
    expect(body).toContain("▶ Play video · 0:14 · <code>src/app</code> · <code>after</code>");
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
      "- [shot-17.png](https://uploads.sh/f/acme/shot-17.png) · `/a_b[c]*d~e~` · `after`",
    );
    // HTML context: <code> needs no markdown escaping, so the value is verbatim.
    expect(body).toContain("<code>/a_b[c]*d~e~</code> · <code>after</code>");
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
      expect(body).toContain("<code>/settings</code> · <code>before</code>");
      expect(body).toContain("<code>/settings</code> · <code>after</code>");
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
      expect(body).toContain("<code>/x</code> · <code>loading</code>");
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

  describe("density-aware auto widths", () => {
    it("maps inlined counts onto solo/sparse/dense tiers", () => {
      expect(attachmentDensityForCount(0)).toBe("solo");
      expect(attachmentDensityForCount(1)).toBe("solo");
      expect(attachmentDensityForCount(2)).toBe("sparse");
      expect(attachmentDensityForCount(3)).toBe("sparse");
      expect(attachmentDensityForCount(4)).toBe("dense");
      expect(attachmentPairWidth("solo")).toBe(400);
      expect(attachmentPairWidth("dense")).toBe(320);
      expect(attachmentImageWidth("hero.png", "solo")).toBe(720);
      expect(attachmentImageWidth("hero.png", "dense")).toBe(400);
    });

    it("renders a single screenshot large enough to read without clicking", () => {
      const body = attachmentsCommentBody([
        {
          key: "gh/acme/web/pull/12/settings.webp",
          url: "https://uploads.sh/f/settings.webp",
          embedUrl: "https://embed.uploads.sh/f/settings.webp",
          pageUrl: "https://uploads.sh/f/acme/settings.webp",
          meta: { path: "/settings", state: "after" },
        },
      ]);
      expect(body).toContain('width="720"');
      expect(body).toContain("<code>/settings</code> · <code>after</code>");
    });

    it("keeps dense historical widths once four or more images are inlined", () => {
      const items = Array.from({ length: 4 }, (_, i) => ({
        key: `gh/acme/web/pull/12/shot-${i}.png`,
        url: `https://uploads.sh/f/shot-${i}.png`,
        embedUrl: `https://embed.uploads.sh/f/shot-${i}.png`,
      }));
      const body = attachmentsCommentBody(items);
      expect(body).toContain('width="400"');
      expect(body).not.toContain('width="720"');
      expect(body).not.toContain('width="560"');
    });
  });

  describe("attachmentsCommentBody with options", () => {
    const items = golden.items as AttachmentItem[];
    const galleries = golden.galleries;
    const marker = golden.marker ?? "<!-- uploads.sh:attachments -->";

    const manyImages: AttachmentItem[] = Array.from({ length: 18 }, (_, i) => ({
      key: `gh/acme/web/pull/12/many-${String(i).padStart(2, "0")}.png`,
      url: `https://uploads.sh/f/many-${i}.png`,
      embedUrl: `https://embed.uploads.sh/f/many-${i}.png`,
      pageUrl: `https://uploads.sh/f/acme/many-${i}.png`,
    }));

    const metaItems: AttachmentItem[] = [
      {
        key: "gh/acme/web/pull/12/meta-a.png",
        url: "https://uploads.sh/f/meta-a.png",
        embedUrl: "https://embed.uploads.sh/f/meta-a.png",
        pageUrl: "https://uploads.sh/f/acme/meta-a.png",
        meta: { path: "apps/web/src", state: "after" },
      },
      {
        key: "gh/acme/web/pull/12/meta-b.png",
        url: "https://uploads.sh/f/meta-b.png",
        embedUrl: "https://embed.uploads.sh/f/meta-b.png",
        pageUrl: "https://uploads.sh/f/acme/meta-b.png",
        meta: { path: "apps/web/src", state: "after" },
      },
    ];

    const galleriesWithPreview = [
      {
        title: "Design review",
        url: "https://uploads.sh/g/abc",
        previews: [
          {
            url: "https://uploads.sh/g/abc/i1.png",
            embedUrl: "https://embed.uploads.sh/g/abc/i1.png",
            alt: "screen one",
            itemUrl: "https://uploads.sh/g/abc/i1",
          },
        ],
      },
    ];

    const base = (over: Partial<CommentRenderOptions>): CommentRenderOptions => ({
      ...AUTO_RENDER_OPTIONS,
      ...over,
    });

    it("default options render byte-identical to the no-options call", () => {
      expect(attachmentsCommentBody(items, galleries, marker, AUTO_RENDER_OPTIONS)).toBe(
        attachmentsCommentBody(items, galleries, marker),
      );
    });

    it('imageWidth:"full" omits the width attribute everywhere (inline, pair, poster)', () => {
      const body = attachmentsCommentBody(items, [], marker, base({ imageWidth: "full" }));
      expect(body).not.toMatch(/<img width=/);
      expect(body).toMatch(/<img alt=/);
    });

    it("explicit px overrides auto sizing and pair/poster constants", () => {
      const body = attachmentsCommentBody(items, [], marker, base({ imageWidth: 500 }));
      const widths = [...body.matchAll(/<img width="(\d+)"/g)].map((m) => Number(m[1]));
      expect(widths.length).toBeGreaterThan(0);
      expect(widths.every((w) => w === 500)).toBe(true);
    });

    it("maxInlineImages caps inline embeds; remainder collapses to the details list", () => {
      const body = attachmentsCommentBody(manyImages, [], marker, base({ maxInlineImages: 2 }));
      expect([...body.matchAll(/<img /g)]).toHaveLength(2);
      expect(body).toContain("<details>");
    });

    it('imageWidth:"full" omits the width attribute on gallery previews too', () => {
      const body = attachmentsCommentBody(
        [],
        galleriesWithPreview,
        marker,
        base({ imageWidth: "full" }),
      );
      expect(body).not.toMatch(/<img width=/);
      expect(body).toMatch(/<img alt="screen one"/);
    });

    it("explicit px overrides the gallery preview's default 320", () => {
      const body = attachmentsCommentBody(
        [],
        galleriesWithPreview,
        marker,
        base({ imageWidth: 500 }),
      );
      const widths = [...body.matchAll(/<img width="(\d+)"/g)].map((m) => Number(m[1]));
      expect(widths).toHaveLength(1);
      expect(widths[0]).toBe(500);
    });

    it("metaPath:false hides path but keeps state in captions", () => {
      const body = attachmentsCommentBody(metaItems, [], marker, base({ metaPath: false }));
      expect(body).not.toContain("apps/web/src");
      expect(body).toContain("after");
    });

    it("metaState:false hides state but keeps path in captions", () => {
      const body = attachmentsCommentBody(metaItems, [], marker, base({ metaState: false }));
      expect(body).toContain("apps/web/src");
      expect(body).not.toContain("<code>after</code>");
      expect(body).not.toMatch(/·\s*after/);
    });

    it("note renders once, directly after the marker line", () => {
      const body = attachmentsCommentBody(items, [], marker, base({ note: "Staging only." }));
      const lines = body.split("\n");
      expect(lines[0]).toBe(marker);
      expect(lines[1]).toBe("Staging only.");
      expect(lines[2]).toBe("");
    });

    it.each(goldenOptions.cases)("matches the options golden: $name", (c) => {
      expect(
        attachmentsCommentBody(c.items ?? items, [], marker, {
          ...AUTO_RENDER_OPTIONS,
          ...c.options,
        }),
      ).toBe(c.expected);
    });
  });
});
