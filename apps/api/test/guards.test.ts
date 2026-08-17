import { describe, expect, it } from "vitest";
import {
  checkDeclaredLength,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  detectContentType,
  detectImageDimensions,
  inspectUpload,
  resolveUploadPolicy,
} from "../src/guards";
import { gifOf, pngOf } from "./helpers/image-fixtures";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);
const ftyp = (brand: string) =>
  new Uint8Array([
    0,
    0,
    0,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...[...brand].map((ch) => ch.charCodeAt(0)),
  ]);

describe("detectContentType", () => {
  it("recognizes each intended type from its magic bytes", () => {
    expect(detectContentType(PNG)).toBe("image/png");
    expect(detectContentType(JPEG)).toBe("image/jpeg");
    expect(detectContentType(GIF)).toBe("image/gif");
    expect(detectContentType(WEBP)).toBe("image/webp");
    expect(detectContentType(WEBM)).toBe("video/webm");
    expect(detectContentType(ftyp("avif"))).toBe("image/avif");
    expect(detectContentType(ftyp("isom"))).toBe("video/mp4");
    expect(detectContentType(ftyp("mp42"))).toBe("video/mp4");
  });

  it("returns null for unrecognized or truncated payloads", () => {
    expect(detectContentType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // zip
    expect(detectContentType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(detectContentType(new Uint8Array([0x89]))).toBeNull();
    expect(detectContentType(new Uint8Array(0))).toBeNull();
  });
});

describe("detectImageDimensions", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(detectImageDimensions(pngOf(800, 600), "image/png")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    expect(detectImageDimensions(gifOf(128, 128), "image/gif")).toEqual({
      width: 128,
      height: 128,
    });
  });

  it("reads JPEG dimensions from the first SOF marker", () => {
    // FFD8, APP0 stub, then SOF0 with height 480 / width 640.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03,
    ]);
    expect(detectImageDimensions(bytes, "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  it("reads WebP dimensions from a VP8X chunk", () => {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46]); // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    // canvas width-1 = 639, height-1 = 479 as 24-bit LE at offsets 24/27
    bytes[24] = 0x7f;
    bytes[25] = 0x02;
    bytes[27] = 0xdf;
    bytes[28] = 0x01;
    expect(detectImageDimensions(bytes, "image/webp")).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for truncated headers and non-image types", () => {
    expect(detectImageDimensions(new Uint8Array([0x89, 0x50]), "image/png")).toBeUndefined();
    expect(detectImageDimensions(gifOf(128, 128).subarray(0, 7), "image/gif")).toBeUndefined();
    expect(detectImageDimensions(new Uint8Array(30), "video/webm")).toBeUndefined();
    expect(detectImageDimensions(new Uint8Array(0), "image/jpeg")).toBeUndefined();
  });
});

describe("checkDeclaredLength", () => {
  const policy = resolveUploadPolicy({ maxUploadBytes: 100 });

  it("rejects a Content-Length over the cap with 413", () => {
    expect(checkDeclaredLength("999", policy)?.status).toBe(413);
  });

  it("passes (null) when the header is within range, absent, or unparseable", () => {
    expect(checkDeclaredLength("50", policy)).toBeNull();
    expect(checkDeclaredLength(undefined, policy)).toBeNull();
    expect(checkDeclaredLength("not-a-number", policy)).toBeNull();
  });
});

describe("resolveUploadPolicy", () => {
  it("uses defaults when the record omits overrides", () => {
    const policy = resolveUploadPolicy({});
    expect(policy.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect([...policy.allowed].sort()).toEqual([...DEFAULT_ALLOWED_CONTENT_TYPES].sort());
  });

  it("applies per-workspace overrides", () => {
    const policy = resolveUploadPolicy({
      maxUploadBytes: 1000,
      allowedContentTypes: ["image/png"],
    });
    expect(policy.maxBytes).toBe(1000);
    expect([...policy.allowed]).toEqual(["image/png"]);
  });

  it("ignores empty or non-positive overrides and falls back", () => {
    const policy = resolveUploadPolicy({ maxUploadBytes: 0, allowedContentTypes: [] });
    expect(policy.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(policy.allowed.size).toBe(DEFAULT_ALLOWED_CONTENT_TYPES.length);
  });
});

describe("inspectUpload", () => {
  const policy = resolveUploadPolicy({});

  it("accepts an allowed type and returns the sniffed content type", () => {
    const result = inspectUpload(PNG, policy);
    expect(result).toEqual({ ok: true, contentType: "image/png" });
  });

  it("rejects payloads over the size cap with 413", () => {
    const small = resolveUploadPolicy({ maxUploadBytes: 4 });
    const result = inspectUpload(PNG, small);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it("rejects a disallowed sniffed type with 415", () => {
    const result = inspectUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("rejects a real image whose type is excluded by policy with 415", () => {
    const gifOnly = resolveUploadPolicy({ allowedContentTypes: ["image/gif"] });
    const result = inspectUpload(PNG, gifOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });
});
