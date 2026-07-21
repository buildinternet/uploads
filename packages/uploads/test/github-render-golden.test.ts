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

describe("attachmentsCommentBody (CLI copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
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
      meta: { path: "/a_b[c]*d", state: "after" },
    }));

    const body = attachmentsCommentBody(items);

    // Markdown context: the metacharacters are backslash-escaped.
    expect(body).toContain(
      "- [shot-17.png](https://uploads.sh/f/acme/shot-17.png) · /a\\_b\\[c\\]\\*d · after",
    );
    // HTML context: <sub> needs no markdown escaping, so the value is verbatim.
    expect(body).toContain("<sub>/a_b[c]*d · after</sub>");
  });
});
