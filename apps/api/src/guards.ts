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

/** Coarse family for 413 payloads and the optimizer/poster branches. */
export type UploadKind = "image" | "video" | "file";

type UploadTypeRow = {
  readonly type: string;
  readonly kind: UploadKind;
  /**
   * `sniff` — recognized by `detectContentType` from its magic bytes.
   * `declared` — no magic bytes at all; accepted only when the client
   * declares the type and the body passes `looksLikeText`.
   */
  readonly verify: "sniff" | "declared";
  /** First entry is canonical: the extension derived when naming a key from a type. */
  readonly extensions: readonly string[];
};

/**
 * The single table behind every upload-type decision: the default allowlist,
 * the video family, which types have no magic bytes, and the extension
 * mapping in both directions.
 *
 * Intended payloads: static images, the short gif/video clips embedded in
 * GitHub repos, and the non-media artifacts agents produce (reports, logs,
 * JSON, archives). Deliberately excludes `image/svg+xml` and `text/html` —
 * storage.uploads.sh is a bare R2 custom domain with no Worker in front of
 * it, so the stored content type is the only control, and either of those
 * served inline can carry script (stored XSS on our own origin). Everything
 * below renders as inert text, opens in a sandboxed viewer (PDF), or has no
 * inline handler at all (zip/gzip).
 */
const UPLOAD_TYPES: readonly UploadTypeRow[] = [
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

const ROW_BY_TYPE: ReadonlyMap<string, UploadTypeRow> = new Map(
  UPLOAD_TYPES.map((row) => [row.type, row]),
);

export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = UPLOAD_TYPES.map((row) => row.type);

const DEFAULT_ALLOWED_SET: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_CONTENT_TYPES);

/** Video content types the upload path (and poster generation) accepts. */
export const VIDEO_TYPES = new Set(
  UPLOAD_TYPES.filter((row) => row.kind === "video").map((row) => row.type),
);

/**
 * Types with no magic bytes. Accepted only when the client declares one of
 * them and the body passes `looksLikeText` — see `inspectUpload`.
 */
export const TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set(
  UPLOAD_TYPES.filter((row) => row.verify === "declared").map((row) => row.type),
);

export function uploadKind(contentType: string): UploadKind {
  const row = ROW_BY_TYPE.get(contentType);
  if (row) return row.kind;
  // Only reachable for a type a workspace added via `allowedContentTypes`;
  // classify it by family prefix.
  if (contentType.startsWith("image/")) return "image";
  return "file";
}

export interface UploadPolicy {
  /** Max for images (and as fallback when maxVideoBytes is unset). */
  maxBytes: number;
  /** Max for video/* when set; otherwise maxBytes. */
  maxVideoBytes: number;
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
 * Extension → content type, built from `UPLOAD_TYPES`. Only the
 * `verify: "declared"` rows can change an admission outcome (an extension is
 * one of the two ways a client declares a text type — see
 * `resolveDeclaredContentType`); the sniffed media rows are here so
 * `details.declared` on a 415 is informative, so a key's extension still
 * names a type, and so the CLI-side `inferContentType`
 * (packages/uploads/src/embed.ts) stays a readable mirror of this list.
 * Neither svg nor html appears in the table at all.
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
 * Validate a fully-buffered upload body against the policy. Sniffed bytes
 * decide the stored type whenever they can; `declaredType` (from the request
 * header or the key's extension — see `resolveDeclaredContentType`) is
 * consulted only when sniffing finds nothing and the claim is one of the
 * text types, which have no magic. Then the type-specific size cap.
 */
export function inspectUpload(
  bytes: Uint8Array,
  policy: UploadPolicy,
  declaredType?: string,
): UploadInspection {
  const detected = detectContentType(bytes);
  let contentType: string | null = null;
  if (detected !== null) {
    if (policy.allowed.has(detected)) contentType = detected;
  } else if (
    declaredType !== undefined &&
    ROW_BY_TYPE.get(declaredType)?.verify === "declared" &&
    policy.allowed.has(declaredType) &&
    looksLikeText(bytes)
  ) {
    contentType = declaredType;
  }
  if (contentType === null) {
    return {
      ok: false,
      status: 415,
      error: new UnsupportedMediaTypeError("unsupported media type", {
        details: {
          allowed: [...policy.allowed],
          ...(declaredType !== undefined ? { declared: declaredType } : {}),
        },
      }),
    };
  }
  const maxBytes = maxBytesForContentType(policy, contentType);
  if (bytes.byteLength > maxBytes) {
    return tooLarge(maxBytes, { contentType, kind: uploadKind(contentType) });
  }
  return { ok: true, contentType };
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
