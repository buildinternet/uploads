import { describe, expect, it } from "vitest";
import { galleryReferenceChip, kindFromCanonicalUrl } from "./gallery-reference-chip";

describe("kindFromCanonicalUrl", () => {
  it("detects pull vs issue from the path", () => {
    expect(kindFromCanonicalUrl("https://github.com/buildinternet/uploads/pull/66")).toBe("pull");
    expect(kindFromCanonicalUrl("https://github.com/buildinternet/uploads/issues/66")).toBe(
      "issue",
    );
  });

  it("returns null for missing, non-github, or unrecognised paths", () => {
    expect(kindFromCanonicalUrl(null)).toBeNull();
    expect(kindFromCanonicalUrl("https://example.com/issues/1")).toBeNull();
    expect(kindFromCanonicalUrl("https://github.com/buildinternet/uploads")).toBeNull();
    expect(kindFromCanonicalUrl("not a url")).toBeNull();
  });
});

describe("galleryReferenceChip", () => {
  it("builds a kind-aware github chip from the canonical URL", () => {
    const chip = galleryReferenceChip({
      provider: "github",
      resourceType: "item",
      coordinate: "buildinternet/uploads#66",
      canonicalUrl: "https://github.com/buildinternet/uploads/issues/66",
    });
    expect(chip.kind).toBe("issue");
    expect(chip.kindLabel).toBe("issue");
    expect(chip.glyph).toBe("kind");
    expect(chip.title).toBeNull();
    expect(chip.coordinate).toBe("buildinternet/uploads#66");
    expect(chip.href).toBe("https://github.com/buildinternet/uploads/issues/66");
    expect(chip.ariaLabel).toBe("issue buildinternet/uploads#66 on GitHub");
  });

  it("prefers API kind + title over URL path", () => {
    const chip = galleryReferenceChip({
      provider: "github",
      resourceType: "item",
      coordinate: "o/r#9",
      // API historically stamps /issues/ even for PRs; kind from resolve wins.
      canonicalUrl: "https://github.com/o/r/issues/9",
      kind: "pull",
      title: "Gallery item parity",
    });
    expect(chip.kind).toBe("pull");
    expect(chip.kindLabel).toBe("pull request");
    expect(chip.glyph).toBe("kind");
    expect(chip.title).toBe("Gallery item parity");
    expect(chip.ariaLabel).toBe("pull request Gallery item parity (o/r#9) on GitHub");
  });

  it("labels pull requests when the URL path says so", () => {
    const chip = galleryReferenceChip({
      provider: "GitHub",
      resourceType: "item",
      coordinate: "o/r#9",
      canonicalUrl: "https://github.com/o/r/pull/9",
    });
    expect(chip.kind).toBe("pull");
    expect(chip.kindLabel).toBe("pull request");
    expect(chip.glyph).toBe("kind");
    expect(chip.ariaLabel).toBe("pull request o/r#9 on GitHub");
  });

  it("leaves non-github providers as plain chips without a kind", () => {
    const chip = galleryReferenceChip({
      provider: "linear",
      resourceType: "issue",
      coordinate: "UP-1",
      canonicalUrl: "https://linear.app/team/issue/UP-1",
    });
    expect(chip.kind).toBeNull();
    expect(chip.kindLabel).toBeNull();
    expect(chip.glyph).toBe("provider");
    expect(chip.provider).toBe("linear");
    expect(chip.ariaLabel).toBe("linear UP-1");
  });

  it("falls back to the GitHub mark when kind is unknown", () => {
    const chip = galleryReferenceChip({
      provider: "github",
      resourceType: "item",
      coordinate: "o/r#9",
      canonicalUrl: "https://github.com/o/r",
    });
    expect(chip.kind).toBeNull();
    expect(chip.glyph).toBe("github-mark");
    expect(chip.ariaLabel).toBe("GitHub o/r#9");
  });
});
