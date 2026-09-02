import { describe, expect, it } from "vitest";
import {
  checkDeclaredLength,
  contentTypeFromKey,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  detectContentType,
  detectImageDimensions,
  inspectUpload,
  looksLikeText,
  resolveDeclaredContentType,
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
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const ZIP_EMPTY = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
const GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]);
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
    expect(detectContentType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(detectContentType(new Uint8Array([0x89]))).toBeNull();
    expect(detectContentType(new Uint8Array(0))).toBeNull();
  });

  it("recognizes the non-media binary types and MOV from their magic bytes", () => {
    expect(detectContentType(PDF)).toBe("application/pdf");
    expect(detectContentType(ZIP)).toBe("application/zip");
    expect(detectContentType(ZIP_EMPTY)).toBe("application/zip");
    expect(detectContentType(GZIP)).toBe("application/gzip");
    expect(detectContentType(ftyp("qt  "))).toBe("video/quicktime");
    // MP4 brands still map to mp4, not quicktime.
    expect(detectContentType(ftyp("isom"))).toBe("video/mp4");
  });

  it("does not sniff text: plain ASCII and UTF-8 bodies return null", () => {
    expect(detectContentType(new TextEncoder().encode("hello world\n"))).toBeNull();
    expect(detectContentType(new TextEncoder().encode('{"ok":true}'))).toBeNull();
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

  it("default allowlist includes the non-media families and quicktime", () => {
    const { allowed } = resolveUploadPolicy({});
    for (const t of [
      "application/pdf",
      "application/zip",
      "application/gzip",
      "video/quicktime",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]) {
      expect(allowed.has(t), t).toBe(true);
    }
    expect(allowed.has("text/html")).toBe(false);
    expect(allowed.has("image/svg+xml")).toBe(false);
  });
});

describe("looksLikeText", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("accepts ASCII and UTF-8 bodies", () => {
    expect(looksLikeText(enc("plain log line\n"))).toBe(true);
    expect(looksLikeText(enc("héllo — ünïcode ✓"))).toBe(true);
  });

  it("rejects NUL bytes and invalid UTF-8", () => {
    expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xe9, 0x74, 0xe9]))).toBe(false); // Latin-1 "été"
    expect(looksLikeText(new Uint8Array(0))).toBe(false);
  });

  it("does not fail on a multibyte sequence cut by the 8 KiB sample boundary", () => {
    // 8190 ASCII bytes, then a 3-byte character straddling offset 8192.
    const body = enc("a".repeat(8190) + "€" + "tail".repeat(50));
    expect(looksLikeText(body)).toBe(true);
  });

  it("only samples the head: a NUL after 8 KiB is not inspected", () => {
    const body = new Uint8Array(9000).fill(0x61);
    body[8500] = 0;
    expect(looksLikeText(body)).toBe(true);
  });
});

describe("contentTypeFromKey", () => {
  it("maps the accepted non-media extensions", () => {
    expect(contentTypeFromKey("gh/o/r/pull/1/build.log")).toBe("text/plain");
    expect(contentTypeFromKey("a/notes.TXT")).toBe("text/plain");
    expect(contentTypeFromKey("a/out.jsonl")).toBe("text/plain");
    expect(contentTypeFromKey("a/config.yaml")).toBe("text/plain");
    expect(contentTypeFromKey("a/README.md")).toBe("text/markdown");
    expect(contentTypeFromKey("a/data.csv")).toBe("text/csv");
    expect(contentTypeFromKey("a/report.json")).toBe("application/json");
    expect(contentTypeFromKey("a/report.pdf")).toBe("application/pdf");
    expect(contentTypeFromKey("a/bundle.zip")).toBe("application/zip");
    expect(contentTypeFromKey("a/bundle.tgz")).toBe("application/gzip");
    expect(contentTypeFromKey("a/clip.mov")).toBe("video/quicktime");
    expect(contentTypeFromKey("a/shot.png")).toBe("image/png");
  });

  it("returns undefined for unknown or missing extensions and never maps html/svg", () => {
    expect(contentTypeFromKey("a/blob")).toBeUndefined();
    expect(contentTypeFromKey("a/page.html")).toBeUndefined();
    expect(contentTypeFromKey("a/icon.svg")).toBeUndefined();
    expect(contentTypeFromKey("a/dir.v2/")).toBeUndefined();
  });
});

describe("resolveDeclaredContentType", () => {
  it("prefers a specific header, normalized", () => {
    expect(resolveDeclaredContentType("Text/Plain; charset=utf-8", "a/x.json")).toBe("text/plain");
  });

  it("falls back to the key extension when the header is absent or octet-stream", () => {
    expect(resolveDeclaredContentType(undefined, "a/build.log")).toBe("text/plain");
    expect(resolveDeclaredContentType("application/octet-stream", "a/build.log")).toBe(
      "text/plain",
    );
    expect(resolveDeclaredContentType("", "a/build.log")).toBe("text/plain");
  });

  it("is undefined when neither source is specific", () => {
    expect(resolveDeclaredContentType(undefined, "a/blob")).toBeUndefined();
    expect(resolveDeclaredContentType("application/octet-stream", "a/blob")).toBeUndefined();
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
    const imagesOnly = resolveUploadPolicy({ allowedContentTypes: ["image/png"] });
    const result = inspectUpload(ZIP, imagesOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("rejects a real image whose type is excluded by policy with 415", () => {
    const gifOnly = resolveUploadPolicy({ allowedContentTypes: ["image/gif"] });
    const result = inspectUpload(PNG, gifOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  const text = new TextEncoder().encode("line one\nline two\n");

  it("accepts a declared text type when the body is plausible text", () => {
    expect(inspectUpload(text, policy, "text/plain")).toEqual({
      ok: true,
      contentType: "text/plain",
    });
    expect(inspectUpload(new TextEncoder().encode('{"a":1}'), policy, "application/json")).toEqual({
      ok: true,
      contentType: "application/json",
    });
  });

  it("sniffed bytes win over a declared text type", () => {
    expect(inspectUpload(PNG, policy, "text/plain")).toEqual({
      ok: true,
      contentType: "image/png",
    });
  });

  it("rejects declared text with binary bytes, an undeclared body, or a non-text declared type", () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    for (const [bytes, declared] of [
      [binary, "text/plain"],
      [text, undefined],
      [text, "application/octet-stream"],
      [text, "text/html"],
      [text, "image/svg+xml"],
      [text, "application/xml"],
    ] as const) {
      const result = inspectUpload(bytes, policy, declared);
      expect(result.ok, `${declared}`).toBe(false);
      if (!result.ok) expect(result.status).toBe(415);
    }
  });

  it("honors a workspace allowlist that excludes text", () => {
    const imagesOnly = resolveUploadPolicy({ allowedContentTypes: ["image/png"] });
    const result = inspectUpload(text, imagesOnly, "text/plain");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("reports the declared type in the 415 details", () => {
    const result = inspectUpload(text, policy, "text/html");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toMatchObject({ declared: "text/html" });
      expect(result.error.details).toHaveProperty("allowed");
    }
  });

  it("caps non-media at maxBytes with kind file, and MOV at maxVideoBytes", () => {
    const tight = resolveUploadPolicy({ maxUploadBytes: 4, maxVideoUploadBytes: 1000 });
    const pdf = inspectUpload(PDF, tight);
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) {
      expect(pdf.status).toBe(413);
      expect(pdf.error.details).toMatchObject({ kind: "file", contentType: "application/pdf" });
    }
    const mov = inspectUpload(ftyp("qt  "), tight);
    expect(mov).toEqual({ ok: true, contentType: "video/quicktime" });
  });
});
