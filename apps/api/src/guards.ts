import {
  PayloadTooLargeError,
  RateLimitedError,
  UnsupportedMediaTypeError,
  type AppError,
} from "@uploads/errors";
import { resolveEffectiveLimits } from "@uploads/billing";
import type { MiddlewareHandler } from "hono";
import type { WorkspaceVars } from "./workspace";

/**
 * Upload guardrails: byte caps, a content-type allowlist backed by magic-byte
 * sniffing, and per-workspace rate limits. Per-workspace overrides are merged
 * in `resolveUploadPolicy`.
 */

/** Default ceiling on a single upload. Covers screenshots and short clips. */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Coarse family for 413 payloads and the optimizer/poster branches. */
export type UploadKind = "image" | "video" | "file";

/**
 * A declared row's verdict. `reason` is a machine-readable 415 detail when
 * the failure is more specific than "didn't pass" (`"active_markup"`).
 */
type Admission = { ok: true } | { ok: false; reason?: string };

type UploadTypeRow = {
  readonly type: string;
  readonly kind: UploadKind;
  /**
   * `sniff`: recognized from magic bytes. `declared`: no magic bytes;
   * accepted only when the client declares the type and the body passes
   * `admit` (default `admitText`).
   */
  readonly verify: "sniff" | "declared";
  /** First entry is canonical. Empty for a declaration-only type (`text/xml`). */
  readonly extensions: readonly string[];
  /** Replaces the `admitText` default entirely; gated rows compose `looksLikeText` themselves. */
  readonly admit?: (bytes: Uint8Array) => Admission;
  /**
   * Per-row byte ceiling tighter than the workspace's, so an oversize body
   * 413s before `admit` decodes and scans it. Set on the gated rows.
   */
  readonly maxBytes?: number;
};

/**
 * The single table behind every upload-type decision: the default allowlist,
 * the video family, which types have no magic bytes, and the extension
 * mapping both ways.
 *
 * `text/html` is excluded outright: served inline from a bare R2 domain, the
 * stored type is the only control, and it can always carry script. SVG/XML
 * carry the same risk but are gated (`GATED_UPLOAD_TYPES`). Everything else
 * renders inert, opens in a sandboxed viewer, or has no inline handler.
 */
const UNGATED_UPLOAD_TYPES: readonly UploadTypeRow[] = [
  { type: "image/png", kind: "image", verify: "sniff", extensions: ["png"] },
  { type: "image/jpeg", kind: "image", verify: "sniff", extensions: ["jpg", "jpeg"] },
  { type: "image/gif", kind: "image", verify: "sniff", extensions: ["gif"] },
  { type: "image/webp", kind: "image", verify: "sniff", extensions: ["webp"] },
  { type: "image/avif", kind: "image", verify: "sniff", extensions: ["avif"] },
  { type: "video/mp4", kind: "video", verify: "sniff", extensions: ["mp4"] },
  { type: "video/webm", kind: "video", verify: "sniff", extensions: ["webm"] },
  { type: "video/quicktime", kind: "video", verify: "sniff", extensions: ["mov"] },
  { type: "application/pdf", kind: "file", verify: "sniff", extensions: ["pdf"] },
  { type: "application/zip", kind: "file", verify: "sniff", extensions: ["zip"] },
  { type: "application/gzip", kind: "file", verify: "sniff", extensions: ["gz", "tgz"] },
  {
    type: "text/plain",
    kind: "file",
    verify: "declared",
    extensions: ["txt", "text", "log", "jsonl", "ndjson", "yaml", "yml"],
  },
  { type: "text/markdown", kind: "file", verify: "declared", extensions: ["md", "markdown"] },
  { type: "text/csv", kind: "file", verify: "declared", extensions: ["csv"] },
  { type: "application/json", kind: "file", verify: "declared", extensions: ["json"] },
];

/**
 * SVG/XML rows: accepted only on a lane whose host is verified to serve them
 * behind a sandboxing CSP (`./active-content.ts`). Declared-only, never
 * sniffed, so a `.log` starting with `<?xml` stays text/plain and a `.png`
 * with SVG bytes still 415s. `admit` is a reputation pre-filter on buffered
 * bodies, not the control (presigned uploads skip it entirely); the CSP is.
 * Capped at 4 MiB so the scan never runs on a large body.
 */
const GATED_MAX_BYTES = 4 * 1024 * 1024;

/** The default declared-row admission: text has no magic bytes, so a plausible decode is all there is to check. */
function admitText(bytes: Uint8Array): Admission {
  return looksLikeText(bytes) ? { ok: true } : { ok: false };
}

/**
 * Admission for a gated row: its shape check, then `containsActiveMarkup`
 * over one decode of the capped body.
 */
function admitMarkup(shape: (bytes: Uint8Array) => boolean): (bytes: Uint8Array) => Admission {
  return (bytes) => {
    if (!shape(bytes)) return { ok: false };
    if (containsActiveMarkup(decodeLossy(bytes))) return { ok: false, reason: "active_markup" };
    return { ok: true };
  };
}

const admitSvg = admitMarkup(looksLikeSvg);
const admitXml = admitMarkup(looksLikeXml);

const GATED_UPLOAD_TYPES: readonly UploadTypeRow[] = [
  {
    type: "image/svg+xml",
    kind: "image",
    verify: "declared",
    extensions: ["svg"],
    maxBytes: GATED_MAX_BYTES,
    admit: admitSvg,
  },
  {
    type: "application/xml",
    kind: "file",
    verify: "declared",
    extensions: ["xml"],
    maxBytes: GATED_MAX_BYTES,
    admit: admitXml,
  },
  {
    // No extension maps here; only an explicit Content-Type can claim it.
    type: "text/xml",
    kind: "file",
    verify: "declared",
    extensions: [],
    maxBytes: GATED_MAX_BYTES,
    admit: admitXml,
  },
];

const UPLOAD_TYPES: readonly UploadTypeRow[] = [...UNGATED_UPLOAD_TYPES, ...GATED_UPLOAD_TYPES];

const ROW_BY_TYPE: ReadonlyMap<string, UploadTypeRow> = new Map(
  UPLOAD_TYPES.map((row) => [row.type, row]),
);

/** The ungated default allowlist. See `GATED_CONTENT_TYPES`. */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = UNGATED_UPLOAD_TYPES.map(
  (row) => row.type,
);

/**
 * The gated SVG/XML types. Never in the default allowlist;
 * `resolveUploadPolicy` adds them only when the `activeContent` gate passed.
 */
export const GATED_CONTENT_TYPES: readonly string[] = GATED_UPLOAD_TYPES.map((row) => row.type);

const DEFAULT_ALLOWED_SET: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_CONTENT_TYPES);
const GATED_SET: ReadonlySet<string> = new Set(GATED_CONTENT_TYPES);

/** Video content types the upload path (and poster generation) accepts. */
export const VIDEO_TYPES = new Set(
  UPLOAD_TYPES.filter((row) => row.kind === "video").map((row) => row.type),
);

export function uploadKind(contentType: string): UploadKind {
  const row = ROW_BY_TYPE.get(contentType);
  if (row) return row.kind;
  // Only reachable for a type a workspace added via `allowedContentTypes`;
  // classify it by family prefix.
  if (contentType.startsWith("image/")) return "image";
  return "file";
}

/** True when `type` is one of the lane-gated SVG/XML rows. */
export function isGatedContentType(type: string): boolean {
  return GATED_SET.has(type);
}

/** The byte ceilings half of an upload policy — see `uploadLimits`. */
export interface UploadLimits {
  /** Max for images (and as fallback when maxVideoBytes is unset). */
  maxBytes: number;
  /** Max for video/* when set; otherwise maxBytes. */
  maxVideoBytes: number;
}

export interface UploadPolicy extends UploadLimits {
  allowed: ReadonlySet<string>;
}

/** Fields a workspace record may carry to override the default upload policy. */
export interface UploadPolicyOverrides {
  maxUploadBytes?: number;
  /** Cap for every type in VIDEO_TYPES (mp4, webm, quicktime). When unset, videos use maxUploadBytes. */
  maxVideoUploadBytes?: number;
  /**
   * A full replacement for the default allowlist, not an extension of it —
   * a workspace with an override does not pick up types added to the
   * default later.
   */
  allowedContentTypes?: string[];
  /**
   * Subscription plan. When set, missing upload caps fall back to the plan's
   * defaults; when unset, to `DEFAULT_MAX_UPLOAD_BYTES`.
   */
  plan?: string;
}

function positiveBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The workspace's byte ceilings from its overrides and plan defaults.
 * Separate from admission: the gated rows change which types are admitted,
 * never how many bytes, so callers that only need a ceiling use this.
 */
export function uploadLimits(record: UploadPolicyOverrides): UploadLimits {
  // A zero, negative or non-finite override collapses to unset before
  // `resolveEffectiveLimits` decides override vs. plan default.
  const resolved = resolveEffectiveLimits({
    plan: record.plan,
    maxUploadBytes: positiveBytes(record.maxUploadBytes),
    maxVideoUploadBytes: positiveBytes(record.maxVideoUploadBytes),
  });
  // No plan stamped: reproduce the legacy fallback exactly.
  const maxBytes = positiveBytes(resolved.maxUploadBytes) ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxVideoBytes = positiveBytes(resolved.maxVideoUploadBytes) ?? maxBytes;
  return { maxBytes, maxVideoBytes };
}

/**
 * The effective upload policy: `uploadLimits` plus the admitted types.
 * `opts.activeContent` is required so no caller can forget the gate. When
 * false, gated types are stripped even from an explicit
 * `allowedContentTypes` override.
 */
export function resolveUploadPolicy(
  record: UploadPolicyOverrides,
  opts: { activeContent: boolean },
): UploadPolicy {
  const limits = uploadLimits(record);
  const base =
    record.allowedContentTypes && record.allowedContentTypes.length > 0
      ? new Set(record.allowedContentTypes)
      : new Set([...DEFAULT_ALLOWED_SET, ...GATED_SET]);
  const allowed = opts.activeContent
    ? base
    : new Set([...base].filter((type) => !GATED_SET.has(type)));
  return { ...limits, allowed };
}

/** Byte ceiling for one type: the workspace's cap, tightened by the row's own `maxBytes`. */
export function maxBytesForContentType(limits: UploadLimits, contentType: string): number {
  const base = VIDEO_TYPES.has(contentType) ? limits.maxVideoBytes : limits.maxBytes;
  const rowMax = ROW_BY_TYPE.get(contentType)?.maxBytes;
  return rowMax !== undefined ? Math.min(base, rowMax) : base;
}

/** True when `bytes` contains `signature` at `offset` (bounds-checked). */
function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** Decode `length` bytes at `offset` as ASCII (empty string if out of range). */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Identify a payload from its leading bytes, returning the canonical MIME type
 * we recognize or `null`. This is what actually stops "a zip renamed to .png":
 * the stored content type comes from the bytes, never from the client header.
 */
export function detectContentType(bytes: Uint8Array): string | null {
  // PNG: \x89PNG\r\n\x1a\n
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // JPEG: FF D8 FF
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF87a / GIF89a
  if (matches(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF....WEBP
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  // WebM / Matroska (EBML header); an .mkv is labeled webm, close enough.
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  // ISO base media (ftyp box at offset 4) — AVIF and MP4 share the container,
  // so split on the brand: the major one at offset 8, or a compatible one
  // after offset 16 when an encoder leads with the generic `mif1`/`msf1`.
  if (matches(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = asciiAt(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "mif1" || brand === "msf1") {
      const boxEnd = Math.min(
        bytes.length,
        ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0,
      );
      for (let at = 16; at + 4 <= boxEnd; at += 4) {
        const compatible = asciiAt(bytes, at, 4);
        if (compatible === "avif" || compatible === "avis") return "image/avif";
      }
    }
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  // %PDF-
  if (matches(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  // PK\x03\x04 (local file header), PK\x05\x06 (empty archive), PK\x07\x08 (spanned)
  if (
    matches(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    matches(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    matches(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  // gzip member header
  if (matches(bytes, [0x1f, 0x8b])) return "application/gzip";
  return null;
}

/** Bytes inspected by `looksLikeText`. Enough to catch binaries; cheap on a 25 MB log. */
const TEXT_SAMPLE_BYTES = 8 * 1024;

/**
 * Plausibility check for declared text uploads (text has no magic bytes):
 * the first 8 KiB must contain no NUL and decode as UTF-8. A multibyte
 * sequence cut by the sample boundary is tolerated via streaming decode.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, TEXT_SAMPLE_BYTES));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample, {
      stream: sample.length < bytes.byteLength,
    });
    return true;
  } catch {
    return false;
  }
}

/** Bytes decoded when sniffing an SVG/XML prefix shape — small on purpose; these are declared-only rows, not a general parser. */
const XML_SNIFF_BYTES = 4 * 1024;

/**
 * Non-throwing UTF-8 decode. `ignoreBOM: false` consumes a leading BOM; the
 * manual strip in `looksLikeSvg` is a fallback.
 */
function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

/**
 * Shape check for declared `image/svg+xml`: `looksLikeText`, and the decoded
 * prefix starts with `<svg` after any BOM, `<?xml ?>` prologs, comments and
 * doctypes. Shape only; `containsActiveMarkup` is separate.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  if (!looksLikeText(bytes)) return false;
  let head = decodeLossy(bytes.subarray(0, Math.min(bytes.byteLength, XML_SNIFF_BYTES)));
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  let prev: string;
  do {
    prev = head;
    head = head
      .replace(/^\s+/, "")
      .replace(/^<\?xml[\s\S]*?\?>/, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<!DOCTYPE[^>]*>/i, "");
  } while (head !== prev && head.length > 0);
  return head.trimStart().startsWith("<svg");
}

/**
 * Shape check for declared XML: `looksLikeText`, and the first non-whitespace
 * character is `<`.
 */
export function looksLikeXml(bytes: Uint8Array): boolean {
  if (!looksLikeText(bytes)) return false;
  const head = decodeLossy(bytes.subarray(0, Math.min(bytes.byteLength, XML_SNIFF_BYTES)));
  return /^\s*</.test(head);
}

/**
 * Known event-handler attribute names. A fixed list, since `on[a-z]+` also
 * matches attributes like `online=` and `once=`.
 */
const EVENT_HANDLER_ATTRS = [
  "onabort",
  "onactivate",
  "onafterprint",
  "onanimationend",
  "onanimationiteration",
  "onanimationstart",
  "onbeforeprint",
  "onbeforeunload",
  "onbegin",
  "onblur",
  "oncancel",
  "oncanplay",
  "oncanplaythrough",
  "onchange",
  "onclick",
  "onclose",
  "oncontextmenu",
  "oncopy",
  "oncuechange",
  "oncut",
  "ondblclick",
  "ondrag",
  "ondragend",
  "ondragenter",
  "ondragleave",
  "ondragover",
  "ondragstart",
  "ondrop",
  "ondurationchange",
  "onemptied",
  "onend",
  "onended",
  "onerror",
  "onfocus",
  "onfocusin",
  "onfocusout",
  "onhashchange",
  "oninput",
  "oninvalid",
  "onkeydown",
  "onkeypress",
  "onkeyup",
  "onload",
  "onloadeddata",
  "onloadedmetadata",
  "onloadstart",
  "onmessage",
  "onmousedown",
  "onmouseenter",
  "onmouseleave",
  "onmousemove",
  "onmouseout",
  "onmouseover",
  "onmouseup",
  "onmousewheel",
  "onoffline",
  "ononline",
  "onpagehide",
  "onpageshow",
  "onpaste",
  "onpause",
  "onplay",
  "onplaying",
  "onpointercancel",
  "onpointerdown",
  "onpointerenter",
  "onpointerleave",
  "onpointermove",
  "onpointerout",
  "onpointerover",
  "onpointerup",
  "onpopstate",
  "onprogress",
  "onratechange",
  "onrepeat",
  "onreset",
  "onresize",
  "onscroll",
  "onsecuritypolicyviolation",
  "onseeked",
  "onseeking",
  "onselect",
  "onshow",
  "onstalled",
  "onstorage",
  "onsubmit",
  "onsuspend",
  "ontimeupdate",
  "ontoggle",
  "ontouchcancel",
  "ontouchend",
  "ontouchmove",
  "ontouchstart",
  "ontransitionend",
  "onunload",
  "onvolumechange",
  "onwaiting",
  "onwheel",
  "onzoom",
] as const;

const EVENT_HANDLER_ATTR_RE = new RegExp(`\\b(?:${EVENT_HANDLER_ATTRS.join("|")})\\s*=`, "i");

/** SMIL `<set>`/`<animate>` retargeting an event attribute, e.g. `<set attributeName="onclick" ...>`. */
const SET_OR_ANIMATE_EVENT_ATTR_RE = /<(?:set|animate)\b[^>]*\bAttributeName\s*=\s*["']?on[a-z]*/i;

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * Decode numeric references and the five named XML entities, so
 * `&#106;avascript:` is judged on what it decodes to. Not a general parser.
 */
function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const codePoint =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        try {
          return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
        } catch {
          return match;
        }
      }
      return NAMED_XML_ENTITIES[entity] ?? match;
    },
  );
}

/**
 * Reputation pre-filter for gated SVG/XML: true for `<script`, a known event
 * handler, `javascript:`, `<foreignObject`, `<?xml-stylesheet`, or SMIL
 * `<set>`/`<animate>` retargeting an event attribute.
 *
 * Not the security control: the sandboxing CSP on the serving lane is, and
 * every gated response ships it. This only rejects the obviously hostile
 * case cheaply; it doesn't parse precisely and can mis-judge unusual markup.
 * It only sees buffered bodies (PUT, MCP put, server copies), never
 * presigned uploads.
 */
export function containsActiveMarkup(text: string): boolean {
  const decoded = decodeXmlEntities(text);
  return (
    /<script|javascript:|<foreignobject|<\?xml-stylesheet/i.test(decoded) ||
    EVENT_HANDLER_ATTR_RE.test(decoded) ||
    SET_OR_ANIMATE_EVENT_ATTR_RE.test(decoded)
  );
}

/**
 * Extension → content type. Only declared rows can change admission; the
 * sniffed rows are here so 415 details and key extensions name a type, and
 * so the CLI's `inferContentType` can mirror this list. `svg`/`xml` name a
 * claim, not an acceptance. `html` never appears.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  UPLOAD_TYPES.flatMap((row) => row.extensions.map((ext) => [ext, row.type] as const)),
);

/** Canonical extension for an accepted content type, or undefined when it is not one. */
export function extensionForContentType(type: string): string | undefined {
  return ROW_BY_TYPE.get(type)?.extensions[0];
}

/** Content type implied by a key's extension, or undefined when unknown. */
export function contentTypeFromKey(key: string): string | undefined {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CONTENT_TYPE_BY_EXTENSION, ext) ? CONTENT_TYPE_BY_EXTENSION[ext] : undefined;
}

/** Normalize a client Content-Type for allowlist compare (type/subtype only, lowercased). */
export function normalizeDeclaredContentType(raw: string): string {
  const beforeParams = raw.split(";", 1)[0] ?? raw;
  return beforeParams.trim().toLowerCase();
}

/**
 * The type a client claims: its Content-Type when specific, else the key's
 * extension. `application/octet-stream` and an empty header count as
 * unspecified (older CLIs, the hosted MCP).
 */
export function resolveDeclaredContentType(
  header: string | undefined,
  key: string,
): string | undefined {
  const normalized = header ? normalizeDeclaredContentType(header) : "";
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return contentTypeFromKey(key);
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Prefix of an `image/svg+xml` body decoded when looking for the root `<svg>` tag's dimensions. */
const SVG_DIMENSION_SNIFF_BYTES = 8 * 1024;

/**
 * Best-effort pixel dimensions from an image header (PNG, GIF, JPEG, WebP,
 * SVG width/height or viewBox). `undefined` when unknown; callers must fail
 * open on that.
 */
export function detectImageDimensions(
  bytes: Uint8Array,
  contentType: string,
): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;

  if (contentType === "image/png") {
    // 8-byte signature, 4-byte chunk length, "IHDR", then BE uint32 w/h.
    if (bytes.length < 24 || !matches(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return undefined;
    return valid(view.getUint32(16, false), view.getUint32(20, false));
  }
  if (contentType === "image/gif") {
    // "GIF8xa" then LE uint16 logical screen width/height.
    if (bytes.length < 10) return undefined;
    return valid(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (contentType === "image/jpeg") {
    // Walk marker segments to the first start-of-frame (SOF0–SOF15, minus
    // the non-frame DHT/DAC/RST markers in that range).
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return valid(view.getUint16(i + 7, false), view.getUint16(i + 5, false));
      }
      i += 2 + view.getUint16(i + 2, false);
    }
    return undefined;
  }
  if (contentType === "image/webp") {
    if (bytes.length < 30) return undefined;
    const chunk = asciiAt(bytes, 12, 4);
    if (chunk === "VP8X") {
      // 24-bit LE canvas width-1 / height-1 at payload offsets 4 and 7.
      const w = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
      const h = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
      return valid(w + 1, h + 1);
    }
    if (chunk === "VP8 ") {
      // Lossy bitstream: 14-bit LE dimensions after the 3-byte frame tag +
      // 3-byte start code (9D 01 2A).
      if (!matches(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
      return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === "VP8L") {
      // Lossless bitstream: signature 0x2f then 14-bit width-1/height-1.
      if (bytes[20] !== 0x2f) return undefined;
      const bits = view.getUint32(21, true);
      return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  if (contentType === "image/svg+xml") {
    // Declared-only: read the root `<svg>`'s width/height (plain numbers or
    // px only; other units need a layout box), else viewBox.
    const head = decodeLossy(
      bytes.subarray(0, Math.min(bytes.byteLength, SVG_DIMENSION_SNIFF_BYTES)),
    );
    const tag = /<svg[\s/>][\s\S]*?>/i.exec(head)?.[0];
    if (!tag) return undefined;
    const attr = (name: string): string | undefined =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
        .exec(tag)
        ?.slice(1, 3)
        .find((v) => v !== undefined);
    const parseLength = (raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const m = /^(\d+(?:\.\d+)?)(px)?$/.exec(raw.trim());
      return m ? Math.round(Number(m[1])) : undefined;
    };
    const width = parseLength(attr("width"));
    const height = parseLength(attr("height"));
    if (width !== undefined && height !== undefined) return valid(width, height);
    const viewBox = attr("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
      return valid(Math.round(viewBox[2]!), Math.round(viewBox[3]!));
    }
    return undefined;
  }
  return undefined;
}

export type UploadRejection = {
  ok: false;
  status: 413 | 415;
  error: AppError;
};
export type UploadInspection = { ok: true; contentType: string } | UploadRejection;

/** The shared 413 rejection for both the pre-buffer and post-buffer size checks. */
function tooLarge(
  maxBytes: number,
  extra?: { contentType?: string; kind?: UploadKind },
): UploadRejection {
  return {
    ok: false,
    status: 413,
    error: new PayloadTooLargeError("payload too large", {
      code: "upload_too_large",
      details: { maxBytes, ...extra },
    }),
  };
}

/**
 * Pre-buffer size gate on a declared `Content-Length`. `inspectUpload` is
 * the backstop. The ceiling is the larger of the image/video caps, tightened
 * only when `declaredType` names a row with its own `maxBytes`, so a 50 MB
 * "SVG" is refused before buffering.
 */
export function checkDeclaredLength(
  contentLength: string | undefined,
  limits: UploadLimits,
  declaredType?: string,
): UploadRejection | null {
  const declared = Number(contentLength);
  const rowMax = declaredType === undefined ? undefined : ROW_BY_TYPE.get(declaredType)?.maxBytes;
  const ceiling = Math.min(Math.max(limits.maxBytes, limits.maxVideoBytes), rowMax ?? Infinity);
  if (Number.isFinite(declared) && declared > ceiling) return tooLarge(ceiling);
  return null;
}

/**
 * The shared 415. `reason` is set only for `lane_not_verified` (gated type,
 * unverified lane) and `active_markup` (gate open, reputation filter failed).
 */
function unsupported(
  policy: UploadPolicy,
  declaredType?: string,
  reason?: string,
): UploadRejection {
  return {
    ok: false,
    status: 415,
    error: new UnsupportedMediaTypeError("unsupported media type", {
      details: {
        allowed: [...policy.allowed],
        ...(declaredType !== undefined ? { declared: declaredType } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    }),
  };
}

/**
 * The declared-type branch of `inspectUpload`. Size before admission, since a
 * gated row's `admit` scans the whole body.
 */
function inspectDeclared(
  bytes: Uint8Array,
  row: UploadTypeRow,
  policy: UploadPolicy,
  declaredType: string,
): UploadInspection {
  const maxBytes = maxBytesForContentType(policy, declaredType);
  if (bytes.byteLength > maxBytes) {
    return tooLarge(maxBytes, { contentType: declaredType, kind: uploadKind(declaredType) });
  }
  const admission = (row.admit ?? admitText)(bytes);
  return admission.ok
    ? { ok: true, contentType: declaredType }
    : unsupported(policy, declaredType, admission.reason);
}

/**
 * Validate a buffered body against the policy. Sniffed bytes decide the
 * stored type when they can; `declaredType` is only consulted when sniffing
 * finds nothing. Then the type-specific size cap.
 */
export function inspectUpload(
  bytes: Uint8Array,
  policy: UploadPolicy,
  declaredType?: string,
  /** Whole-body size when `bytes` is only its head (a streamed upload). */
  size = bytes.byteLength,
): UploadInspection {
  const detected = detectContentType(bytes);
  if (detected !== null) {
    if (!policy.allowed.has(detected))
      return unsupported(policy, declaredType, laneReason(policy, declaredType));
    const maxBytes = maxBytesForContentType(policy, detected);
    return size > maxBytes
      ? tooLarge(maxBytes, { contentType: detected, kind: uploadKind(detected) })
      : { ok: true, contentType: detected };
  }
  if (declaredType !== undefined && policy.allowed.has(declaredType)) {
    const row = ROW_BY_TYPE.get(declaredType);
    if (row?.verify === "declared") return inspectDeclared(bytes, row, policy, declaredType);
  }
  return unsupported(policy, declaredType, laneReason(policy, declaredType));
}

/** `"lane_not_verified"` when the claim is a gated type this lane hasn't verified for; nothing otherwise. */
function laneReason(policy: UploadPolicy, declaredType?: string): string | undefined {
  return declaredType !== undefined &&
    GATED_SET.has(declaredType) &&
    !policy.allowed.has(declaredType)
    ? "lane_not_verified"
    : undefined;
}

/**
 * A per-workspace rate-limit guard over a `RateLimit` binding: middleware
 * that 429s, plus a standalone `allow`. Fails open without the binding.
 * Windows are per-colo, enough to blunt abuse.
 *
 * `opts.windowSeconds` mirrors the binding's period so the 429 can send an
 * honest `Retry-After`; the binding reveals nothing else.
 */
export function makeRateLimitGuard<BindingKey extends string>(
  bindingKey: BindingKey,
  message: string,
  opts: { windowSeconds?: number; code?: string } = {},
): {
  middleware: MiddlewareHandler<WorkspaceVars>;
  allow: (env: Partial<Record<BindingKey, RateLimit>>, workspaceName: string) => Promise<boolean>;
  reject: () => never;
} {
  const allow = async (
    env: Partial<Record<BindingKey, RateLimit>>,
    workspaceName: string,
  ): Promise<boolean> => {
    const limiter = env[bindingKey];
    if (!limiter) return true;
    const { success } = await limiter.limit({ key: workspaceName });
    return success;
  };

  const reject = (): never => {
    throw new RateLimitedError(message, {
      ...(opts.code ? { code: opts.code } : {}),
      ...(opts.windowSeconds !== undefined ? { retryAfterSeconds: opts.windowSeconds } : {}),
    });
  };

  const middleware: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
    const env = c.env as unknown as Partial<Record<BindingKey, RateLimit>>;
    if (!(await allow(env, c.get("workspaceName")))) reject();
    await next();
  };

  return { middleware, allow, reject };
}

/**
 * Per-workspace rate limit for mutating requests (`WRITE_LIMITER`), used by
 * the file put/delete routes and the MCP worker's put/delete tools.
 */
const writeRateLimitGuard = makeRateLimitGuard("WRITE_LIMITER", "rate limit exceeded", {
  windowSeconds: 60,
});
export const writeRateLimit = writeRateLimitGuard.middleware;
export const allowWrite = writeRateLimitGuard.allow;

/**
 * Burst limit for POST /v1/render. Browser hours bill to us, so this guards
 * against hot loops independent of the monthly budget.
 */
const renderRateLimitGuard = makeRateLimitGuard("RENDER_LIMITER", "render rate limit exceeded", {
  windowSeconds: 60,
});
export const renderRateLimit = renderRateLimitGuard.middleware;
export const allowRender = renderRateLimitGuard.allow;

/**
 * Per-workspace rate limit for video poster generation (`POSTER_LIMITER`),
 * used by `posterGenerationAllowed` in poster.ts.
 */
const posterRateLimitGuard = makeRateLimitGuard("POSTER_LIMITER", "poster rate limit exceeded");
export const allowPoster = posterRateLimitGuard.allow;

/**
 * Per-user limit for self-serve workspace creation, with a window matching
 * the create cap so concurrent requests can't race past it. Fails open
 * without the binding.
 */
export async function allowWorkspaceCreate(
  env: { WS_CREATE_LIMITER?: RateLimit },
  userId: string,
): Promise<boolean> {
  const limiter = env.WS_CREATE_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: userId });
  return success;
}
