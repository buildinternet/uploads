import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  optimizeImageForUpload,
  rewriteKeyExtension,
  withImageExtension,
} from "../src/optimize.js";

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  // Compressible solid color — real screenshots shrink more; this still beats raw PNG size.
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 80, b: 160 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("withImageExtension / rewriteKeyExtension", () => {
  it("rewrites a trailing image extension", () => {
    expect(withImageExtension("shot.png", "webp")).toBe("shot.webp");
    expect(withImageExtension("dir/shot.PNG", "webp")).toBe("dir/shot.webp");
    expect(rewriteKeyExtension("gh/o/r/pull/1/shot.png", "shot.webp")).toBe(
      "gh/o/r/pull/1/shot.webp",
    );
  });

  it("appends when the name has no image extension", () => {
    expect(withImageExtension("shot", "webp")).toBe("shot.webp");
    expect(withImageExtension("archive.tar.gz", "webp")).toBe("archive.tar.gz.webp");
  });
});

describe("optimizeImageForUpload", () => {
  it("converts a large PNG to a smaller WebP and rewrites the filename", async () => {
    const png = await solidPng(1200, 800);
    const result = await optimizeImageForUpload(png, "dashboard.png");
    expect(result.optimized).toBe(true);
    expect(result.filename).toBe("dashboard.webp");
    expect(result.contentType).toBe("image/webp");
    expect(result.outputBytes).toBeLessThan(result.originalBytes);
    expect(result.bytes.byteLength).toBe(result.outputBytes);
    // RIFF....WEBP
    expect(String.fromCharCode(...result.bytes.subarray(0, 4))).toBe("RIFF");
  });

  it("respects --no-optimize / enabled: false", async () => {
    const png = await solidPng(400, 300);
    const result = await optimizeImageForUpload(png, "shot.png", { enabled: false });
    expect(result.optimized).toBe(false);
    expect(result.skippedReason).toBe("disabled");
    expect(result.filename).toBe("shot.png");
    expect(result.bytes).toBe(png);
  });

  it("skips non-images", async () => {
    const bytes = new TextEncoder().encode("not an image");
    const result = await optimizeImageForUpload(bytes, "notes.txt");
    expect(result.optimized).toBe(false);
    expect(result.skippedReason).toBe("not_image");
    expect(result.filename).toBe("notes.txt");
  });

  it("skips SVG", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    const result = await optimizeImageForUpload(svg, "icon.svg");
    expect(result.optimized).toBe(false);
    expect(result.skippedReason).toBe("svg");
  });

  it("caps the long edge when larger than maxEdge", async () => {
    const png = await solidPng(4000, 2000);
    const result = await optimizeImageForUpload(png, "wide.png", {
      maxEdge: 1000,
      quality: 80,
    });
    expect(result.optimized).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(1000);
    expect(meta.height).toBeLessThanOrEqual(1000);
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1000);
  });

  it("keeps the original when the optimized payload is not smaller", async () => {
    // Tiny already-efficient WebP often won't shrink further at high quality.
    const webp = new Uint8Array(
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .webp({ quality: 80 })
        .toBuffer(),
    );
    const result = await optimizeImageForUpload(webp, "tiny.webp", { quality: 90 });
    // Either not_smaller or still optimized — must never grow the payload.
    expect(result.outputBytes).toBeLessThanOrEqual(result.originalBytes);
    if (!result.optimized) expect(result.skippedReason).toBe("not_smaller");
  });

  it("strips EXIF by default and preserves it with keepExif", async () => {
    const jpeg = new Uint8Array(
      await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 90, g: 40, b: 20 },
        },
      })
        .jpeg({ quality: 95 })
        .withMetadata({
          exif: {
            IFD0: {
              Copyright: "uploads-exif-fixture",
              Software: "uploads-test",
            },
          },
        })
        .toBuffer(),
    );
    const withExif = await sharp(jpeg).metadata();
    expect(withExif.exif).toBeTruthy();

    const stripped = await optimizeImageForUpload(jpeg, "photo.jpg");
    expect(stripped.optimized).toBe(true);
    const strippedMeta = await sharp(stripped.bytes).metadata();
    expect(strippedMeta.exif).toBeUndefined();

    const kept = await optimizeImageForUpload(jpeg, "photo.jpg", { keepExif: true });
    expect(kept.optimized).toBe(true);
    const keptMeta = await sharp(kept.bytes).metadata();
    expect(keptMeta.exif).toBeTruthy();
    expect(Buffer.from(kept.bytes).includes(Buffer.from("uploads-exif-fixture"))).toBe(true);
  });
});
