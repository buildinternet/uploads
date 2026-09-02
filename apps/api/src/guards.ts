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
 * Upload guardrails for the hosted API: byte caps and a content-type
 * allowlist backed by magic-byte sniffing, plus a per-workspace write rate
 * limit. Defaults live here; per-workspace overrides ride on the
 * `WorkspaceRecord` and are merged in `resolveUploadPolicy`.
 */

/** Default ceiling on a single upload. Covers screenshots and short clips. */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Coarse family for 413 payloads and the optimizer/poster branches. */
export type UploadKind = "image" | "video" | "file";

/**
 * One declared row's verdict on a body: accepted, or rejected — with a
 * machine-readable `details.reason` for the 415 when the failure is more
 * specific than "the declared type didn't pass its check" (today just
 * `"active_markup"`).
 */
type Admission = { ok: true } | { ok: false; reason?: string };

type UploadTypeRow = {
  readonly type: string;
  readonly kind: UploadKind;
  /**
   * `sniff` — recognized by `detectContentType` from its magic bytes.
   * `declared` — no magic bytes at all; accepted only when the client
   * declares the type and the body passes the row's `admit` check
   * (defaults to `admitText` when the row doesn't name its own).
   */
  readonly verify: "sniff" | "declared";
  /** First entry is canonical: the extension derived when naming a key from a type. Empty for a declaration-only type with no key convention (`text/xml`). */
  readonly extensions: readonly string[];
  /**
   * Declared-row admission check `inspectDeclared` runs instead of the bare
   * `admitText` default. Every declared row that names one relies on it
   * entirely (not layered on top of `looksLikeText` by the caller) — the
   * gated SVG/XML rows below compose `looksLikeText` themselves.
   */
  readonly admit?: (bytes: Uint8Array) => Admission;
  /**
   * Per-row byte ceiling, tighter than the workspace's own `maxBytes`/
   * `maxVideoBytes` — set on the gated SVG/XML rows (issue #929 review) so
   * `inspectDeclared` can reject an oversize declared body with 413 *before*
   * `admit` ever decodes/regex-scans it (the decode and
   * `containsActiveMarkup` are O(body size), and these rows are meant to
   * stay small). Absent means "no tighter cap than the workspace's own" —
   * see `maxBytesForContentType`.
   */
  readonly maxBytes?: number;
};

/**
 * The single table behind every upload-type decision: the default allowlist,
 * the video family, which types have no magic bytes, and the extension
 * mapping in both directions.
 *
 * Intended payloads: static images, the short gif/video clips embedded in
 * GitHub repos, and the non-media artifacts agents produce (reports, logs,
 * JSON, archives). Deliberately excludes `text/html` outright — served
 * inline from a bare R2 custom domain with no Worker in front of it (the
 * stored content type is the only control), it can always carry script.
 * `image/svg+xml`/`application/xml`/`text/xml` (below, `GATED_UPLOAD_TYPES`)
 * carry the same risk but are accepted — declared-only, plausibility-
 * filtered, and only on a lane proven to serve them behind a sandboxing CSP
 * (issue #929, `./active-content.ts`). Everything else renders as inert
 * text, opens in a sandboxed viewer (PDF), or has no inline handler at all
 * (zip/gzip).
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
 * `image/svg+xml`, `application/xml`, `text/xml` — accepted only on a lane
 * whose public host is verified to serve them behind a sandboxing CSP
 * (issue #929, spec "Guards"). Declared-only, never sniffed, on purpose: a
 * `.log` that starts with `<?xml` keeps being `text/plain`, and a `.png`
 * carrying SVG bytes still 415s (sniffing wins in `inspectUpload` whenever
 * it recognizes anything at all). Each row's `admit` runs a reputation
 * pre-filter over a *buffered* body — PUT, MCP, and server-side copies all
 * decode it — which is not the control: the sandboxing CSP on the serving
 * host is what actually neutralizes an active payload, and a presigned
 * upload writes straight to the bucket with no server inspection at all,
 * `admit` included. `maxBytes` caps every row at 4 MiB, well under the
 * general upload ceiling, so `inspectDeclared` can reject an oversize body
 * with 413 before `admit` decodes/regex-scans it at all — see
 * `maxBytesForContentType`.
 */
const GATED_MAX_BYTES = 4 * 1024 * 1024;

/** The default declared-row admission: text has no magic bytes, so a plausible decode is all there is to check. */
function admitText(bytes: Uint8Array): Admission {
  return looksLikeText(bytes) ? { ok: true } : { ok: false };
}

/**
 * Admission for a gated SVG/XML row: the row's own shape check first, then —
 * over a single decode of the whole (small, `maxBytes`-capped) body — the
 * `containsActiveMarkup` reputation filter, whose failure is specific enough
 * to name in the 415.
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
    // Declaration-only: no extension maps to it, so a key's extension alone
    // can never claim this type — only an explicit Content-Type header can.
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

/** The ungated default allowlist — unchanged by issue #929; see `GATED_CONTENT_TYPES`. */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = UNGATED_UPLOAD_TYPES.map(
  (row) => row.type,
);

/**
 * `image/svg+xml`, `application/xml`, `text/xml` — never in
 * `DEFAULT_ALLOWED_CONTENT_TYPES`; `resolveUploadPolicy` adds them only when
 * its caller's `activeContent` gate passed (issue #929).
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

/** True when `type` is one of the lane-gated SVG/XML rows (issue #929). */
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
   * Subscription plan (issue #613). Set → `maxUploadBytes`/`maxVideoUploadBytes`
   * fall back to that plan's `defaultLimits` (via `resolveEffectiveLimits`)
   * instead of `DEFAULT_MAX_UPLOAD_BYTES` when the record carries no explicit
   * override. Unset (legacy/operator-provisioned workspaces) reproduces
   * pre-billing behavior byte-for-byte: no plan defaults apply.
   */
  plan?: string;
}

function positiveBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The workspace's byte ceilings, resolved from its own overrides and its
 * plan's defaults. Deliberately separate from admission (`resolveUploadPolicy`
 * below): a limit is plan-and-override arithmetic only, so it is the same
 * number whether or not the active-content gate (issue #929) is open. That is
 * why every caller that only needs a ceiling — the PUT route's pre-buffer
 * `Content-Length` check, the MCP `put` pre-decode ceiling, `github-ingest` —
 * calls this instead of building a whole policy behind a made-up gate value:
 * the gated SVG/XML rows change which *types* are admitted, never how many
 * bytes a workspace may send.
 */
export function uploadLimits(record: UploadPolicyOverrides): UploadLimits {
  // Sanitize before handing off to the shared resolution seam, same pattern
  // as `budget.ts`'s `resolveBudgetLimits`: a zero/negative/non-finite
  // override collapses to "unset" here, *before* `resolveEffectiveLimits`
  // decides whether that counts as an explicit override or falls back to
  // the plan default.
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
 * Builds the effective upload policy for a workspace: `uploadLimits` plus the
 * admitted type set. `opts.activeContent` (issue #929) is required — never
 * defaulted — so no caller can forget to pass its `activeContentAllowed(env,
 * ws)` result and silently open (or close) the gated SVG/XML rows. When
 * `false`, the gated types are stripped from the resulting `allowed` set even
 * when the workspace's own `allowedContentTypes` override names one
 * explicitly — an override extends or restricts the ungated allowlist, it
 * can't bypass lane verification.
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

/**
 * The effective byte ceiling for one content type: the workspace's own
 * `maxVideoBytes`/`maxBytes`, tightened by the row's own `maxBytes` when it
 * has one (issue #929 review — the gated SVG/XML rows cap at 4 MiB
 * regardless of how high a workspace's general upload ceiling is set).
 */
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
  // WebM / Matroska (EBML header). We only serve webm; an .mkv would be
  // labeled webm, which is close enough for a guardrail.
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  // ISO base media (ftyp box at offset 4) — AVIF and MP4 share the container,
  // so split on the major brand at offset 8.
  if (matches(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = asciiAt(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
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
 * Best-effort UTF-8 decode of `bytes`, never throwing (mirrors
 * `TextDecoder`'s default non-fatal mode). `ignoreBOM: false` means a
 * leading BOM is consumed rather than left in the output — the explicit
 * manual strip in `looksLikeSvg` below is a defensive fallback, not the
 * primary mechanism.
 */
function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

/**
 * Shape check for a declared `image/svg+xml` upload: `looksLikeText`, and
 * — in the first {@link XML_SNIFF_BYTES} decoded — the text starts with
 * `<svg` once a leading BOM and any number of `<?xml … ?>` prologs,
 * `<!-- … -->` comments, and `<!DOCTYPE …>` declarations (in any order) are
 * stripped. Pure shape; the reputation pre-filter (`containsActiveMarkup`)
 * is a separate, composed check — see `GATED_UPLOAD_TYPES`.
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
 * Shape check for a declared `application/xml`/`text/xml` upload:
 * `looksLikeText`, and the first non-whitespace character (within the first
 * {@link XML_SNIFF_BYTES} decoded) is `<`. Deliberately looser than
 * {@link looksLikeSvg} — any well-formed-looking XML document, not just one
 * rooted at a specific element.
 */
export function looksLikeXml(bytes: Uint8Array): boolean {
  if (!looksLikeText(bytes)) return false;
  const head = decodeLossy(bytes.subarray(0, Math.min(bytes.byteLength, XML_SNIFF_BYTES)));
  return /^\s*</.test(head);
}

/**
 * Reputation pre-filter for a gated SVG/XML body (issue #929): true when the
 * text contains a `<script` tag, an `on*=` event-handler attribute, a
 * `javascript:` URL, `<foreignObject` (SVG can embed arbitrary HTML through
 * it), or an `<?xml-stylesheet` processing instruction (can point at an XSLT
 * that runs script). This is defense in depth, not the control, and it only
 * ever runs on a *buffered* body a server handler actually reads — the PUT
 * route, the MCP `put` tool, and server-side copies (`putOptsFromStoredObject`
 * bypasses the gate entirely, so this filter never even applies there). A
 * presigned upload writes straight to the bucket over HTTP with no server in
 * the loop, so nothing here ever inspects it — which is exactly why the
 * sandboxing CSP the serving lane is verified to send (`./active-content.ts`)
 * is the actual control, not this filter.
 *
 * `\bon[a-z]+\s*=` is deliberately broad: it also matches ordinary
 * non-handler attributes that happen to start with "on", e.g. `online=` or
 * `once=` on an unrelated element — a false-positive 415, not a security
 * gap, and reputation defense in depth is allowed to be loose. Revisit if
 * that starts rejecting real uploads often enough to bite.
 */
export function containsActiveMarkup(text: string): boolean {
  return /<script|\bon[a-z]+\s*=|javascript:|<foreignobject|<\?xml-stylesheet/i.test(text);
}

/**
 * Extension → content type, built from `UPLOAD_TYPES`. Only the
 * `verify: "declared"` rows can change an admission outcome (an extension is
 * one of the two ways a client declares a text type — see
 * `resolveDeclaredContentType`); the sniffed media rows are here so
 * `details.declared` on a 415 is informative, so a key's extension still
 * names a type, and so the CLI-side `inferContentType`
 * (packages/uploads/src/embed.ts) stays a readable mirror of this list.
 * `svg`/`xml` map to their gated types (declaration-only still applies —
 * this table only ever feeds `contentTypeFromKey`, which names a claim, not
 * an acceptance); `text/xml` has no extension, so it can only ever be
 * claimed by an explicit Content-Type header. `html` never appears.
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
 * The type a client *claims* for an upload: its Content-Type header when
 * specific, else the key's extension. Only consulted by `inspectUpload` for
 * text types (everything else is sniffed). `application/octet-stream` and an
 * empty header count as unspecified so older CLIs (which send octet-stream
 * for `.log`) and the hosted MCP (which sends no type) still resolve via the
 * key.
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

/**
 * Best-effort pixel dimensions read straight from an image's header —
 * PNG (IHDR), GIF (logical screen descriptor), JPEG (first SOF marker),
 * WebP (VP8X/VP8/VP8L chunk). Returns `undefined` for any other content
 * type or a header it can't decode; callers that gate on dimensions must
 * fail open on `undefined` rather than treating it as zero.
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
 * Pre-buffer size gate: reject on a declared `Content-Length` over the
 * ceiling before the body is read into isolate memory. `inspectUpload` is
 * the authoritative backstop for type-specific limits.
 *
 * With `declaredType` (the caller knows what the client claims — the PUT
 * route's `resolveDeclaredContentType`), the ceiling is that type's own
 * (`maxBytesForContentType`), so a declared 50 MB SVG is refused before it
 * is buffered rather than after — the gated SVG/XML rows cap at 4 MiB and
 * their plausibility check decodes the whole body. Without it, the larger of
 * the image/video caps, which is the loosest any body could be admitted at.
 */
export function checkDeclaredLength(
  contentLength: string | undefined,
  limits: UploadLimits,
  declaredType?: string,
): UploadRejection | null {
  const declared = Number(contentLength);
  const ceiling =
    declaredType !== undefined
      ? maxBytesForContentType(limits, declaredType)
      : Math.max(limits.maxBytes, limits.maxVideoBytes);
  if (Number.isFinite(declared) && declared > ceiling) return tooLarge(ceiling);
  return null;
}

/**
 * The shared 415. `reason` is a machine-readable narrowing of *why*, present
 * only in the two cases specific enough to name (issue #929 review): the
 * declared type is gated and this workspace's lane hasn't verified for it
 * (`lane_not_verified`), or the gate is open but the body's own reputation
 * filter, not its shape, is what failed (`active_markup`). Every other
 * rejection carries none — the generic 415 stands.
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
 * The declared-type branch of `inspectUpload`: bytes no sniffer recognized,
 * under a claim the policy allows and a row that accepts claims at all.
 * Size first, admission second — a declared row's `admit` (the gated
 * SVG/XML rows especially) decodes and regex-scans the *whole* body, so an
 * oversize payload has to 413 before that scan runs, not after (issue #929
 * review).
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
 * Validate a fully-buffered upload body against the policy. Sniffed bytes
 * decide the stored type whenever they can; `declaredType` (from the request
 * header or the key's extension — see `resolveDeclaredContentType`) is
 * consulted only when sniffing finds nothing and the claim is a declared
 * row, which have no magic. Then the type-specific size cap.
 */
export function inspectUpload(
  bytes: Uint8Array,
  policy: UploadPolicy,
  declaredType?: string,
): UploadInspection {
  const detected = detectContentType(bytes);
  if (detected !== null) {
    if (!policy.allowed.has(detected))
      return unsupported(policy, declaredType, laneReason(policy, declaredType));
    const maxBytes = maxBytesForContentType(policy, detected);
    return bytes.byteLength > maxBytes
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
 * Builds a per-workspace rate-limit guard on top of a named `RateLimit`
 * binding: a Hono middleware that 429s when the limit is exceeded, plus the
 * standalone `allow` check for non-route callers. Keyed by workspace name so
 * one tenant's traffic can't exhaust another's budget. Fails open when the
 * binding is absent (some local/dev setups, tests) — the window/quota
 * themselves are fixed per-binding in wrangler.jsonc (fixed sliding windows,
 * per-colo rather than globally exact — enough to blunt abuse, not billing).
 *
 * `opts.windowSeconds` is the binding's configured `simple.period`, mirrored
 * here purely so the 429 can carry an honest `Retry-After`: the window length
 * is the only recovery figure a Cloudflare `RateLimit` binding makes knowable
 * — `limit()` returns `{ success }` and nothing else, so limit/remaining/reset
 * are deliberately never emitted (see `respondError`). Waiting out one full
 * window is always sufficient, which is exactly what `Retry-After` promises.
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
    // `c.env` is the worker's full Env; narrowed here since this guard only
    // ever reads the single `bindingKey` binding off of it.
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
 * Burst rate limit for POST /v1/render (`RENDER_LIMITER`) — browser-hours
 * bill to our account, so this guards against a hot loop hammering the
 * endpoint independent of the monthly upload-budget check (`checkPutBudget`,
 * reused for renders in routes/render.ts).
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
 * Strict per-user rate limit for self-serve workspace creation. Kept separate
 * from WRITE_LIMITER (60/60s) so the create-cap check (3 self-serve workspaces
 * per user) can't be raced past via concurrent requests — this limiter's
 * window matches the cap. Fails open when the binding is absent (some
 * local/dev setups, tests).
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
