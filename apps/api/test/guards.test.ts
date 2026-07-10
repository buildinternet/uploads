import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  detectContentType,
  inspectUpload,
  normalizeContentType,
  resolveUploadPolicy,
} from "../src/guards";

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

describe("normalizeContentType", () => {
  it("strips parameters and lowercases", () => {
    expect(normalizeContentType("Image/PNG; charset=binary")).toBe("image/png");
    expect(normalizeContentType(undefined)).toBe("");
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
