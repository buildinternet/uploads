import type { MiddlewareHandler } from "hono";
import type { WorkspaceVars } from "./workspace";

/**
 * Upload guardrails for the hosted API: a byte cap and a content-type
 * allowlist backed by magic-byte sniffing, plus a per-workspace write rate
 * limit. Defaults live here; per-workspace overrides ride on the
 * `WorkspaceRecord` (`maxUploadBytes` / `allowedContentTypes`) and are merged
 * in `resolveUploadPolicy`.
 */

/** Default ceiling on a single upload. Covers screenshots and short clips. */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Intended payloads: static images plus the short gif/video clips embedded in
 * GitHub repos. Deliberately excludes `image/svg+xml` — an SVG served inline
 * from storage.uploads.sh can carry script (stored XSS on our own origin).
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
];

export interface UploadPolicy {
  maxBytes: number;
  allowed: Set<string>;
}

/** Fields a workspace record may carry to override the default upload policy. */
export interface UploadPolicyOverrides {
  maxUploadBytes?: number;
  allowedContentTypes?: string[];
}

export function resolveUploadPolicy(record: UploadPolicyOverrides): UploadPolicy {
  const maxBytes =
    typeof record.maxUploadBytes === "number" && record.maxUploadBytes > 0
      ? record.maxUploadBytes
      : DEFAULT_MAX_UPLOAD_BYTES;
  const allowed =
    record.allowedContentTypes && record.allowedContentTypes.length > 0
      ? record.allowedContentTypes
      : DEFAULT_ALLOWED_CONTENT_TYPES;
  return { maxBytes, allowed: new Set(allowed) };
}

/** Strip parameters (`; charset=…`) and normalize case for header comparison. */
export function normalizeContentType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

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
    return "video/mp4";
  }
  return null;
}

export type UploadInspection =
  | { ok: true; contentType: string }
  | { ok: false; status: 413 | 415; body: Record<string, unknown> };

/**
 * Validate a fully-buffered upload body against the policy. Size is checked
 * again here (the pre-buffer Content-Length check can be absent or lying), then
 * the sniffed type must be on the allowlist.
 */
export function inspectUpload(bytes: Uint8Array, policy: UploadPolicy): UploadInspection {
  if (bytes.byteLength > policy.maxBytes) {
    return {
      ok: false,
      status: 413,
      body: { error: "payload too large", maxBytes: policy.maxBytes },
    };
  }
  const detected = detectContentType(bytes);
  if (detected === null || !policy.allowed.has(detected)) {
    return {
      ok: false,
      status: 415,
      body: { error: "unsupported media type", allowed: [...policy.allowed] },
    };
  }
  return { ok: true, contentType: detected };
}

/**
 * The Rate Limiting API binding (configured under `unsafe.bindings` in
 * wrangler.jsonc). Unsafe bindings aren't emitted by `wrangler types`, so we
 * describe the shape locally and read it off `env` defensively — when the
 * binding is absent (some local/dev setups, tests) the middleware no-ops.
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Per-workspace rate limit for mutating requests. Keyed by workspace name so
 * one tenant's traffic can't exhaust another's budget. The window and quota
 * are fixed in wrangler.jsonc (the binding is a fixed sliding window); it's
 * per-colo rather than globally exact — enough to blunt abuse, not billing.
 */
export const writeRateLimit: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
  const limiter = (c.env as { WRITE_LIMITER?: RateLimiter }).WRITE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.get("workspaceName") });
    if (!success) return c.json({ error: "rate limit exceeded" }, 429);
  }
  await next();
};
