import { describe, expect, it } from "vitest";
import { buildMarkdown, buildUploadMarkdown } from "../src/embed.js";

describe("buildMarkdown", () => {
  it("emits image markdown without width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot" })).toBe(
      "![shot](https://x.test/a.png)",
    );
  });

  it("emits an img tag with width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot", width: 700 })).toBe(
      '<img width="700" alt="shot" src="https://x.test/a.png">',
    );
  });
});

describe("buildUploadMarkdown", () => {
  it("falls through to image markdown when a URL is present", () => {
    expect(buildUploadMarkdown("https://x.test/a.png", { alt: "shot", key: "gh/a.png" })).toBe(
      "![shot](https://x.test/a.png)",
    );
  });

  it("falls through to the img-width form when width is set", () => {
    expect(
      buildUploadMarkdown("https://x.test/a.png", { alt: "shot", width: 700, key: "gh/a.png" }),
    ).toBe('<img width="700" alt="shot" src="https://x.test/a.png">');
  });

  it("returns a plain-text fallback naming the key when url is null", () => {
    const markdown = buildUploadMarkdown(null, { alt: "shot", key: "gh/a.png" });
    expect(markdown).toContain("`gh/a.png`");
    expect(markdown).toContain("no public URL");
  });

  it("returns a plain-text fallback naming the key when url is undefined", () => {
    const markdown = buildUploadMarkdown(undefined, { alt: "shot", key: "gh/a.png" });
    expect(markdown).toContain("`gh/a.png`");
    expect(markdown).toContain("no public URL");
  });
});
