import { describe, expect, it } from "vitest";
import { buildMarkdown, buildUploadMarkdown, inferContentType } from "../src/embed.js";

describe("inferContentType", () => {
  it("maps media and the accepted non-media extensions", () => {
    expect(inferContentType("shot.png")).toBe("image/png");
    expect(inferContentType("clip.webm")).toBe("video/webm");
    expect(inferContentType("clip.MOV")).toBe("video/quicktime");
    expect(inferContentType("report.pdf")).toBe("application/pdf");
    expect(inferContentType("bundle.zip")).toBe("application/zip");
    expect(inferContentType("bundle.tar.gz")).toBe("application/gzip");
    expect(inferContentType("bundle.tgz")).toBe("application/gzip");
    expect(inferContentType("build.log")).toBe("text/plain");
    expect(inferContentType("notes.txt")).toBe("text/plain");
    expect(inferContentType("events.jsonl")).toBe("text/plain");
    expect(inferContentType("config.yml")).toBe("text/plain");
    expect(inferContentType("README.md")).toBe("text/markdown");
    expect(inferContentType("data.csv")).toBe("text/csv");
    expect(inferContentType("lighthouse.json")).toBe("application/json");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(inferContentType("blob")).toBe("application/octet-stream");
    expect(inferContentType("page.html")).toBe("application/octet-stream");
  });
});

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
