import { describe, expect, it } from "vitest";
import {
  checkDeclaredLength,
  containsActiveMarkup,
  contentTypeFromKey,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  detectContentType,
  detectImageDimensions,
  extensionForContentType,
  GATED_CONTENT_TYPES,
  inspectUpload,
  looksLikeSvg,
  looksLikeText,
  looksLikeXml,
  resolveDeclaredContentType,
  resolveUploadPolicy,
  TEXT_CONTENT_TYPES,
} from "../src/guards";
import { gifOf, pngOf } from "./helpers/image-fixtures";
import { AVIF, ftyp, GZIP, MOV, PDF, ZIP, ZIP_EMPTY } from "./helpers/media-fixtures";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);

describe("detectContentType", () => {
  it("recognizes each intended type from its magic bytes", () => {
    expect(detectContentType(PNG)).toBe("image/png");
    expect(detectContentType(JPEG)).toBe("image/jpeg");
    expect(detectContentType(GIF)).toBe("image/gif");
    expect(detectContentType(WEBP)).toBe("image/webp");
    expect(detectContentType(WEBM)).toBe("video/webm");
    expect(detectContentType(AVIF)).toBe("image/avif");
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
    expect(detectContentType(MOV)).toBe("video/quicktime");
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
  const policy = resolveUploadPolicy({ maxUploadBytes: 100 }, { activeContent: false });

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
    const policy = resolveUploadPolicy({}, { activeContent: false });
    expect(policy.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect([...policy.allowed].sort()).toEqual([...DEFAULT_ALLOWED_CONTENT_TYPES].sort());
  });

  it("applies per-workspace overrides", () => {
    const policy = resolveUploadPolicy(
      {
        maxUploadBytes: 1000,
        allowedContentTypes: ["image/png"],
      },
      { activeContent: false },
    );
    expect(policy.maxBytes).toBe(1000);
    expect([...policy.allowed]).toEqual(["image/png"]);
  });

  it("ignores empty or non-positive overrides and falls back", () => {
    const policy = resolveUploadPolicy(
      { maxUploadBytes: 0, allowedContentTypes: [] },
      { activeContent: false },
    );
    expect(policy.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(policy.allowed.size).toBe(DEFAULT_ALLOWED_CONTENT_TYPES.length);
  });

  it("default allowlist includes the non-media families and quicktime", () => {
    const { allowed } = resolveUploadPolicy({}, { activeContent: false });
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

  it("resolves pro-plan defaults for both image and video caps when unset", () => {
    const policy = resolveUploadPolicy({ plan: "pro" });
    expect(policy.maxBytes).toBe(100_000_000);
    expect(policy.maxVideoBytes).toBe(100_000_000);
  });

  it("resolves free-plan defaults for both image and video caps when unset", () => {
    const policy = resolveUploadPolicy({ plan: "free" });
    expect(policy.maxBytes).toBe(25_000_000);
    expect(policy.maxVideoBytes).toBe(25_000_000);
  });

  it("an explicit override beats the plan default", () => {
    const policy = resolveUploadPolicy({ plan: "pro", maxUploadBytes: 1000 });
    expect(policy.maxBytes).toBe(1000);
    // video has no override of its own, so it resolves independently to the
    // plan's video default (not to the overridden maxBytes).
    expect(policy.maxVideoBytes).toBe(100_000_000);
  });

  it("an explicit video override beats the plan default independently of maxBytes", () => {
    const policy = resolveUploadPolicy({ plan: "pro", maxVideoUploadBytes: 5000 });
    expect(policy.maxBytes).toBe(100_000_000);
    expect(policy.maxVideoBytes).toBe(5000);
  });

  it("falls back to the legacy DEFAULT_MAX_UPLOAD_BYTES when no plan is stamped", () => {
    const policy = resolveUploadPolicy({});
    expect(policy.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(policy.maxVideoBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it("video falls back to maxBytes when only the video field is unresolved", () => {
    const policy = resolveUploadPolicy({ plan: "pro", maxVideoUploadBytes: 0 });
    expect(policy.maxBytes).toBe(100_000_000);
    expect(policy.maxVideoBytes).toBe(100_000_000);
  });
});

describe("resolveUploadPolicy — active-content gate (issue #929)", () => {
  it("gated types are absent from the default allowlist when the gate is closed", () => {
    const policy = resolveUploadPolicy({}, { activeContent: false });
    for (const t of GATED_CONTENT_TYPES) expect(policy.allowed.has(t), t).toBe(false);
  });

  it("gated types join the default allowlist when the gate is open", () => {
    const policy = resolveUploadPolicy({}, { activeContent: true });
    for (const t of GATED_CONTENT_TYPES) expect(policy.allowed.has(t), t).toBe(true);
    // Ungated defaults are still present too — the gate only adds, never replaces.
    for (const t of DEFAULT_ALLOWED_CONTENT_TYPES) expect(policy.allowed.has(t), t).toBe(true);
  });

  it("an allowedContentTypes override naming a gated type is stripped without the gate", () => {
    const policy = resolveUploadPolicy(
      { allowedContentTypes: ["image/png", "image/svg+xml"] },
      { activeContent: false },
    );
    expect([...policy.allowed]).toEqual(["image/png"]);
  });

  it("an allowedContentTypes override naming a gated type keeps it with the gate open", () => {
    const policy = resolveUploadPolicy(
      { allowedContentTypes: ["image/png", "image/svg+xml"] },
      { activeContent: true },
    );
    expect([...policy.allowed].sort()).toEqual(["image/png", "image/svg+xml"]);
  });

  it("an override cannot smuggle in a gated type it never named, even with the gate open", () => {
    const policy = resolveUploadPolicy(
      { allowedContentTypes: ["image/png"] },
      { activeContent: true },
    );
    expect(policy.allowed.has("application/xml")).toBe(false);
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

  it("rejects a multibyte sequence truncated at end of file", () => {
    expect(looksLikeText(new Uint8Array([0x61, 0xe2]))).toBe(false);
  });
});

describe("looksLikeSvg", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("accepts a bare <svg> root", () => {
    expect(looksLikeSvg(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
  });

  it("accepts <svg> preceded by an XML prolog, a comment, and a DOCTYPE, in any order", () => {
    expect(
      looksLikeSvg(enc('<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated --><svg></svg>')),
    ).toBe(true);
    expect(
      looksLikeSvg(
        enc(
          '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg></svg>',
        ),
      ),
    ).toBe(true);
    expect(looksLikeSvg(enc("<!-- a --><!-- b -->\n<svg></svg>"))).toBe(true);
  });

  it("strips a leading BOM before checking", () => {
    expect(looksLikeSvg(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("<svg></svg>")]))).toBe(true);
  });

  it("rejects a non-SVG root element and non-text bytes", () => {
    expect(looksLikeSvg(enc("<html><body>hi</body></html>"))).toBe(false);
    expect(looksLikeSvg(enc('{"svg": true}'))).toBe(false);
    expect(looksLikeSvg(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });
});

describe("looksLikeXml", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("accepts text whose first non-whitespace character is <", () => {
    expect(looksLikeXml(enc('<?xml version="1.0"?><report></report>'))).toBe(true);
    expect(looksLikeXml(enc("\n\n  <root/>"))).toBe(true);
  });

  it("rejects text not starting with < and non-text bytes", () => {
    expect(looksLikeXml(enc("hello <world/>"))).toBe(false);
    expect(looksLikeXml(new Uint8Array([0x00, 0x01]))).toBe(false);
  });
});

describe("containsActiveMarkup", () => {
  it("flags script tags, event handlers, javascript: URLs, foreignObject, and xml-stylesheet", () => {
    expect(containsActiveMarkup("<svg><script>alert(1)</script></svg>")).toBe(true);
    expect(containsActiveMarkup('<svg onload="alert(1)"></svg>')).toBe(true);
    expect(containsActiveMarkup('<a href="javascript:alert(1)">x</a>')).toBe(true);
    expect(containsActiveMarkup("<svg><foreignObject></foreignObject></svg>")).toBe(true);
    expect(containsActiveMarkup('<?xml-stylesheet href="x.xsl"?><a/>')).toBe(true);
    expect(containsActiveMarkup("<SCRIPT>x</SCRIPT>")).toBe(true);
  });

  it("passes inert markup", () => {
    expect(containsActiveMarkup('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(
      false,
    );
    expect(containsActiveMarkup("<report><item>one</item></report>")).toBe(false);
  });
});

describe("the upload-type table", () => {
  it("is coherent: every allowed type round-trips through its canonical extension, and text types are allowed", () => {
    for (const type of DEFAULT_ALLOWED_CONTENT_TYPES) {
      const ext = extensionForContentType(type);
      expect(ext, type).toBeDefined();
      expect(contentTypeFromKey(`a/file.${ext}`), type).toBe(type);
    }
    for (const type of TEXT_CONTENT_TYPES) {
      expect(DEFAULT_ALLOWED_CONTENT_TYPES, type).toContain(type);
    }
  });

  it("gated types with an extension round-trip too; text/xml is declaration-only and has none", () => {
    expect(GATED_CONTENT_TYPES).toEqual(["image/svg+xml", "application/xml", "text/xml"]);
    for (const type of ["image/svg+xml", "application/xml"]) {
      const ext = extensionForContentType(type);
      expect(ext, type).toBeDefined();
      expect(contentTypeFromKey(`a/file.${ext}`), type).toBe(type);
    }
    expect(extensionForContentType("text/xml")).toBeUndefined();
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

  it("returns undefined for unknown or missing extensions and never maps html", () => {
    expect(contentTypeFromKey("a/blob")).toBeUndefined();
    expect(contentTypeFromKey("a/page.html")).toBeUndefined();
    expect(contentTypeFromKey("a/dir.v2/")).toBeUndefined();
  });

  it("maps the gated extensions (issue #929) as a claim only — acceptance is separately gated", () => {
    expect(contentTypeFromKey("a/icon.svg")).toBe("image/svg+xml");
    expect(contentTypeFromKey("a/report.xml")).toBe("application/xml");
  });

  it("does not resolve through inherited Object.prototype keys", () => {
    expect(contentTypeFromKey("a/x.constructor")).toBeUndefined();
    expect(contentTypeFromKey("a/x.toString")).toBeUndefined();
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
  const policy = resolveUploadPolicy({}, { activeContent: false });

  it("accepts an allowed type and returns the sniffed content type", () => {
    const result = inspectUpload(PNG, policy);
    expect(result).toEqual({ ok: true, contentType: "image/png" });
  });

  it("rejects payloads over the size cap with 413", () => {
    const small = resolveUploadPolicy({ maxUploadBytes: 4 }, { activeContent: false });
    const result = inspectUpload(PNG, small);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it("rejects a disallowed sniffed type with 415", () => {
    const imagesOnly = resolveUploadPolicy(
      { allowedContentTypes: ["image/png"] },
      { activeContent: false },
    );
    const result = inspectUpload(ZIP, imagesOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("rejects a real image whose type is excluded by policy with 415", () => {
    const gifOnly = resolveUploadPolicy(
      { allowedContentTypes: ["image/gif"] },
      { activeContent: false },
    );
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
    const imagesOnly = resolveUploadPolicy(
      { allowedContentTypes: ["image/png"] },
      { activeContent: false },
    );
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
    const tight = resolveUploadPolicy(
      { maxUploadBytes: 4, maxVideoUploadBytes: 1000 },
      { activeContent: false },
    );
    const pdf = inspectUpload(PDF, tight);
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) {
      expect(pdf.status).toBe(413);
      expect(pdf.error.details).toMatchObject({ kind: "file", contentType: "application/pdf" });
    }
    const mov = inspectUpload(MOV, tight);
    expect(mov).toEqual({ ok: true, contentType: "video/quicktime" });
  });
});

describe("inspectUpload — gated SVG/XML types (issue #929)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const gated = resolveUploadPolicy({}, { activeContent: true });

  it("accepts an inert declared SVG, with or without a prolog/comment", () => {
    expect(inspectUpload(enc("<svg></svg>"), gated, "image/svg+xml")).toEqual({
      ok: true,
      contentType: "image/svg+xml",
    });
    expect(
      inspectUpload(enc('<?xml version="1.0"?>\n<!-- x --><svg></svg>'), gated, "image/svg+xml"),
    ).toEqual({ ok: true, contentType: "image/svg+xml" });
  });

  it("415s a declared SVG containing <script>", () => {
    const result = inspectUpload(
      enc("<svg><script>alert(1)</script></svg>"),
      gated,
      "image/svg+xml",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("415s a declared SVG whose root is not <svg>", () => {
    const result = inspectUpload(enc("<html></html>"), gated, "image/svg+xml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("stores real PNG bytes as png even when declared as svg", () => {
    expect(inspectUpload(PNG, gated, "image/svg+xml")).toEqual({
      ok: true,
      contentType: "image/png",
    });
  });

  it("accepts declared application/xml starting with an XML prolog", () => {
    expect(
      inspectUpload(enc('<?xml version="1.0"?><report></report>'), gated, "application/xml"),
    ).toEqual({ ok: true, contentType: "application/xml" });
  });

  it("415s a declared application/xml containing active markup", () => {
    const result = inspectUpload(enc('<report onload="x()"></report>'), gated, "application/xml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("a .log key with an XML-looking body declared text/plain stays text/plain, not xml", () => {
    const result = inspectUpload(enc('<?xml version="1.0"?><a/>'), gated, "text/plain");
    expect(result).toEqual({ ok: true, contentType: "text/plain" });
  });

  it("415s every gated type when the gate is closed, even for an otherwise-inert body", () => {
    const closed = resolveUploadPolicy({}, { activeContent: false });
    for (const declared of ["image/svg+xml", "application/xml", "text/xml"] as const) {
      const result = inspectUpload(enc("<svg></svg>"), closed, declared);
      expect(result.ok, declared).toBe(false);
      if (!result.ok) expect(result.status).toBe(415);
    }
  });
});
