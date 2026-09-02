import {
  PayloadTooLargeError,
  RateLimitedError,
  UnsupportedMediaTypeError,
  type AppError,
} from "@uploads/errors";
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

/**
 * Intended payloads: static images, the short gif/video clips embedded in
 * GitHub repos, and the non-media artifacts agents produce (reports, logs,
 * JSON, archives). Deliberately excludes `image/svg+xml` and `text/html` —
 * storage.uploads.sh is a bare R2 custom domain with no Worker in front of
 * it, so the stored content type is the only control, and either of those
 * served inline can carry script (stored XSS on our own origin). Everything
 * below renders as inert text, opens in a sandboxed viewer (PDF), or has no
 * inline handler at all (zip/gzip).
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const DEFAULT_ALLOWED_SET = new Set(DEFAULT_ALLOWED_CONTENT_TYPES);

/** Video content types the upload path (and poster generation) accepts. */
export const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/**
 * Types with no magic bytes. Accepted only when the client declares one of
 * them and the body passes `looksLikeText` — see `inspectUpload`.
 */
export const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export interface UploadPolicy {
  /** Max for images (and as fallback when maxVideoBytes is unset). */
  maxBytes: number;
  /** Max for video/* when set; otherwise maxBytes. */
  maxVideoBytes: number;
  allowed: Set<string>;
}

/** Fields a workspace record may carry to override the default upload policy. */
export interface UploadPolicyOverrides {
  maxUploadBytes?: number;
  /** Cap for video/mp4 and video/webm. When unset, videos use maxUploadBytes. */
  maxVideoUploadBytes?: number;
  allowedContentTypes?: string[];
}

function positiveBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveUploadPolicy(record: UploadPolicyOverrides): UploadPolicy {
  const maxBytes = positiveBytes(record.maxUploadBytes) ?? DEFAULT_MAX_UPLOAD_BYTES;
  const maxVideoBytes = positiveBytes(record.maxVideoUploadBytes) ?? maxBytes;
  const allowed =
    record.allowedContentTypes && record.allowedContentTypes.length > 0
      ? new Set(record.allowedContentTypes)
      : DEFAULT_ALLOWED_SET;
  return { maxBytes, maxVideoBytes, allowed };
}

export function maxBytesForContentType(policy: UploadPolicy, contentType: string): number {
  return VIDEO_TYPES.has(contentType) ? policy.maxVideoBytes : policy.maxBytes;
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

/**
 * Extension → content type for the key-extension fallback in
 * `resolveDeclaredContentType`. Mirrors `inferContentType` in
 * packages/uploads/src/embed.ts; keep the two in step. html/svg are absent on
 * purpose — they must never become a declared type.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  jsonl: "text/plain",
  ndjson: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Content type implied by a key's extension, or undefined when unknown. */
export function contentTypeFromKey(key: string): string | undefined {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return CONTENT_TYPE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
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
  extra?: { contentType?: string; kind?: "image" | "video" },
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
 * Pre-buffer size gate: reject on a declared `Content-Length` over the larger
 * of image/video caps before the body is read into isolate memory.
 * `inspectUpload` is the authoritative backstop for type-specific limits.
 */
export function checkDeclaredLength(
  contentLength: string | undefined,
  policy: UploadPolicy,
): UploadRejection | null {
  const declared = Number(contentLength);
  const ceiling = Math.max(policy.maxBytes, policy.maxVideoBytes);
  if (Number.isFinite(declared) && declared > ceiling) return tooLarge(ceiling);
  return null;
}

/**
 * Validate a fully-buffered upload body against the policy: sniffed type
 * against the allowlist, then the type-specific size cap.
 */
export function inspectUpload(bytes: Uint8Array, policy: UploadPolicy): UploadInspection {
  const detected = detectContentType(bytes);
  if (detected === null || !policy.allowed.has(detected)) {
    return {
      ok: false,
      status: 415,
      error: new UnsupportedMediaTypeError("unsupported media type", {
        details: { allowed: [...policy.allowed] },
      }),
    };
  }
  const maxBytes = maxBytesForContentType(policy, detected);
  const kind = VIDEO_TYPES.has(detected) ? ("video" as const) : ("image" as const);
  if (bytes.byteLength > maxBytes) {
    return tooLarge(maxBytes, { contentType: detected, kind });
  }
  return { ok: true, contentType: detected };
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
