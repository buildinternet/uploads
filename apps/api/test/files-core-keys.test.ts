import { describe, expect, it } from "vitest";
import { downloadFilename, governUploadKey, sanitizeKeyBasename } from "../src/files-core";

describe("governUploadKey", () => {
  it("prefixes bare basenames", () => {
    const key = governUploadKey("shot.png");
    expect(key).toMatch(/^f\/[A-Za-z0-9_-]+\/shot\.png$/);
  });

  it("leaves nested keys unchanged", () => {
    expect(governUploadKey("screenshots/app/1/shot.png")).toBe("screenshots/app/1/shot.png");
    expect(governUploadKey("gh/o/r/pull/1/a.png")).toBe("gh/o/r/pull/1/a.png");
  });

  it("can disable auto-prefix", () => {
    expect(governUploadKey("shot.png", false)).toBe("shot.png");
  });

  it("sanitizes basename characters", () => {
    expect(sanitizeKeyBasename("my shot!!.png")).toBe("my-shot.png");
  });
});

describe("downloadFilename", () => {
  const pr = "gh/buildinternet/uploads/pull/1142";

  it("restores the original name when the key was derived from it", () => {
    expect(downloadFilename(`${pr}/127-0-0-1-admin.webp`, "127.0.0.1-admin.webp")).toBe(
      "127.0.0.1-admin.webp",
    );
    expect(downloadFilename(`${pr}/my-shot-1.png`, "my shot (1).png")).toBe("my shot (1).png");
  });

  it("keeps the stored extension when the client optimized the bytes", () => {
    expect(downloadFilename(`${pr}/127-0-0-1-admin.webp`, "127.0.0.1-admin.png")).toBe(
      "127.0.0.1-admin.webp",
    );
  });

  it("matches through the dated layout's content hash", () => {
    expect(
      downloadFilename("screenshots/uploads/2026-10-18/my-shot-1-a1b2c3.png", "my shot (1).png"),
    ).toBe("my shot (1).png");
  });

  it("falls back to the key basename otherwise", () => {
    expect(downloadFilename(`${pr}/hero.png`)).toBe("hero.png");
    expect(downloadFilename(`${pr}/hero.png`, "shot.png")).toBe("hero.png");
    expect(downloadFilename(`${pr}/hero-zzzzzz.png`, "hero.png")).toBe("hero-zzzzzz.png");
    // Keys written before the dash rule keep their own (dotted) name.
    expect(downloadFilename(`${pr}/127.0.0.1-admin.webp`, "127.0.0.1-admin.png")).toBe(
      "127.0.0.1-admin.webp",
    );
  });

  it("ignores any directory part of the source name", () => {
    expect(downloadFilename(`${pr}/a-b.png`, "/tmp/shots/a.b.png")).toBe("a.b.png");
  });
});
