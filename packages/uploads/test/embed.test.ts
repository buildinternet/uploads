import { describe, expect, it } from "vitest";
import {
  buildAttachmentMarkdown,
  buildMarkdown,
  buildUploadMarkdown,
  fileKindFromName,
  inferContentType,
} from "../src/embed.js";

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

describe("fileKindFromName", () => {
  it("classifies by the inferred type, with unknown for unmapped extensions", () => {
    expect(fileKindFromName("shot.png")).toBe("image");
    expect(fileKindFromName("icon.svg")).toBe("image");
    expect(fileKindFromName("clip.MOV")).toBe("video");
    expect(fileKindFromName("clip.webm")).toBe("video");
    expect(fileKindFromName("report.pdf")).toBe("file");
    expect(fileKindFromName("build.log")).toBe("file");
    expect(fileKindFromName("data.csv")).toBe("file");
    expect(fileKindFromName("screenshot")).toBe("unknown");
    expect(fileKindFromName("page.html")).toBe("unknown");
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

  it("prints a plain link, not broken image syntax, for a non-image file (issue #1030)", () => {
    expect(
      buildUploadMarkdown("https://x.test/gh/1/sample-e2e.log", {
        alt: "sample-e2e.log",
        key: "gh/1/sample-e2e.log",
        filename: "sample-e2e.log",
      }),
    ).toBe("[sample-e2e.log](https://x.test/gh/1/sample-e2e.log)");
  });

  it("prints a plain link for a PDF with no poster available at upload time", () => {
    expect(
      buildUploadMarkdown("https://x.test/gh/1/report.pdf", {
        alt: "report.pdf",
        key: "gh/1/report.pdf",
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    ).toBe("[report.pdf](https://x.test/gh/1/report.pdf)");
  });

  it("prints a poster-linked image for a PDF with a poster available", () => {
    expect(
      buildUploadMarkdown("https://x.test/gh/1/report.pdf", {
        alt: "report.pdf",
        key: "gh/1/report.pdf",
        filename: "report.pdf",
        contentType: "application/pdf",
        posterUrl: "https://x.test/_internal/posters/report.pdf.jpg",
      }),
    ).toBe(
      "[![report.pdf](https://x.test/_internal/posters/report.pdf.jpg)](https://x.test/gh/1/report.pdf)",
    );
  });

  it("defaults filename to the key's basename when omitted", () => {
    expect(
      buildUploadMarkdown("https://x.test/gh/1/build.log", {
        alt: "build.log",
        key: "gh/1/build.log",
      }),
    ).toBe("[build.log](https://x.test/gh/1/build.log)");
  });
});

describe("buildAttachmentMarkdown", () => {
  it("emits image markdown for an image, unchanged", () => {
    expect(buildAttachmentMarkdown("shot.png", "https://x.test/shot.png", { alt: "shot" })).toBe(
      "![shot](https://x.test/shot.png)",
    );
  });

  it("emits an img tag with width for an image", () => {
    expect(
      buildAttachmentMarkdown("shot.png", "https://x.test/shot.png", { alt: "shot", width: 700 }),
    ).toBe('<img width="700" alt="shot" src="https://x.test/shot.png">');
  });

  it("prints a plain link for a PDF with no poster", () => {
    expect(
      buildAttachmentMarkdown("report.pdf", "https://x.test/report.pdf", { alt: "report.pdf" }),
    ).toBe("[report.pdf](https://x.test/report.pdf)");
  });

  it("prints a poster-linked image for a PDF with a poster", () => {
    expect(
      buildAttachmentMarkdown("report.pdf", "https://x.test/report.pdf", {
        alt: "report.pdf",
        posterUrl: "https://x.test/poster.jpg",
      }),
    ).toBe("[![report.pdf](https://x.test/poster.jpg)](https://x.test/report.pdf)");
  });

  it("prints a poster-linked image for a video with a poster", () => {
    expect(
      buildAttachmentMarkdown("demo.mp4", "https://x.test/demo.mp4", {
        alt: "demo.mp4",
        posterUrl: "https://x.test/poster.jpg",
      }),
    ).toBe("[![demo.mp4](https://x.test/poster.jpg)](https://x.test/demo.mp4)");
  });

  it("prints a plain link for a video with no poster", () => {
    expect(
      buildAttachmentMarkdown("demo.mp4", "https://x.test/demo.mp4", { alt: "demo.mp4" }),
    ).toBe("[demo.mp4](https://x.test/demo.mp4)");
  });

  it("prints a plain link for every other non-image type, ignoring any poster", () => {
    expect(
      buildAttachmentMarkdown("bundle.zip", "https://x.test/bundle.zip", {
        alt: "bundle.zip",
        posterUrl: "https://x.test/poster.jpg",
      }),
    ).toBe("[bundle.zip](https://x.test/bundle.zip)");
  });

  it("prefers an explicit contentType over the filename extension", () => {
    expect(
      buildAttachmentMarkdown("upload", "https://x.test/upload", {
        alt: "upload",
        contentType: "image/png",
      }),
    ).toBe("![upload](https://x.test/upload)");
  });

  it("ignores application/octet-stream and falls back to the filename extension", () => {
    expect(
      buildAttachmentMarkdown("shot.png", "https://x.test/shot.png", {
        alt: "shot.png",
        contentType: "application/octet-stream",
      }),
    ).toBe("![shot.png](https://x.test/shot.png)");
  });
});
