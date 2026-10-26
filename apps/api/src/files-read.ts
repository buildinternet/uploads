/** Storage read helpers shared by API and viewer without upload generation. */
import type { Files } from "@uploads/storage";
import { sanitizeFilename } from "@uploads/comment-render";

export const UPLOADED_AT_META_KEY = "uploaded-at";
const KEY_RE = /^[\w!*'()./-]+$/;

export function badKey(key: string): boolean {
  return (
    !KEY_RE.test(key) ||
    key.length > 1024 ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

/** Same-second tolerance so storage noise does not force dual public date fields. */
const PUBLIC_DATE_EQUAL_MS = 1000;

/**
 * Public share/gallery date fields from a Files SDK head.
 * Prefer `uploaded-at` stamp; fall back to provider `lastModified`.
 * Emit `modified` only when mtime meaningfully differs (fresh put → single field).
 */
export function publicObjectDateFields(meta: {
  lastModified?: number;
  metadata?: Record<string, string>;
}): { uploaded?: string; modified?: string } {
  const modifiedIso =
    meta.lastModified != null && Number.isFinite(meta.lastModified)
      ? new Date(meta.lastModified).toISOString()
      : undefined;
  const stamped = meta.metadata?.[UPLOADED_AT_META_KEY];
  const uploadedIso =
    typeof stamped === "string" && Number.isFinite(Date.parse(stamped))
      ? new Date(stamped).toISOString()
      : modifiedIso;

  if (!uploadedIso) return {};
  if (
    !modifiedIso ||
    Math.abs(Date.parse(modifiedIso) - Date.parse(uploadedIso)) < PUBLIC_DATE_EQUAL_MS
  ) {
    return { uploaded: uploadedIso };
  }
  return { uploaded: uploadedIso, modified: modifiedIso };
}

/** Non-ASCII-safe fallback for the `filename=` param (browsers that ignore `filename*`). */
function asciiFilenameFallback(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

/** RFC 5987 `filename*=UTF-8''...` value for a Content-Disposition header. */
function encodeRfc5987Filename(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

/**
 * Stream a stored object as a forced-download `Response`. Shared by the
 * public file (`routes/public-files.ts`, behind `?download=1`) and public
 * gallery-item (`routes/public-galleries.ts`) download routes (design spec
 * §3.4) — bytes are proxied through this Worker specifically for the download
 * action (the inline-preview path keeps using the R2 custom domain directly,
 * unchanged). Full-file only: no `Range` support. Uses `StoredFile.stream()`
 * so the whole object is never buffered into Worker memory.
 */
export async function downloadResponse(store: Files, key: string): Promise<Response> {
  const file = await store.download(key);
  return attachmentResponse(file, downloadFilename(key, file.metadata?.["source-name"]));
}

/** Last extension including its dot (`.png`), or "" when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

/**
 * Filename a download is saved under. Keys dash interior dots and special
 * characters (`sanitizeFilename`), so when the uploader's original basename
 * (the `source-name` provenance value) is the name this key was derived
 * from, hand that back instead — with the stored extension, since an
 * optimized `shot.png` is stored as `.webp`. "Derived from" means the
 * original sanitizes to the key's basename, optionally plus the dated
 * layout's `-<6 hex>` content hash. A renamed upload (`--name`), a missing
 * `source-name`, or any other mismatch falls back to the key's basename.
 */
export function downloadFilename(key: string, sourceName?: string): string {
  const keyName = key.split("/").filter(Boolean).pop() ?? key;
  const original = sourceName?.split(/[\\/]/).pop()?.trim();
  if (!original) return keyName;
  const keyExt = extensionOf(keyName);
  const srcExt = extensionOf(original);
  const candidate = `${srcExt ? original.slice(0, -srcExt.length) : original}${keyExt}`;
  const sanitized = sanitizeFilename(candidate);
  if (sanitized === keyName) return candidate;
  const stem = sanitized.slice(0, sanitized.length - extensionOf(sanitized).length);
  const rest = keyName.startsWith(stem) ? keyName.slice(stem.length) : "";
  return /^-[0-9a-f]{6}$/.test(rest.slice(0, rest.length - keyExt.length)) && rest.endsWith(keyExt)
    ? candidate
    : keyName;
}

/** `downloadResponse` for a body already in hand (a held copy, for one). */
export function attachmentResponse(
  file: { type: string; size?: number; stream(): ReadableStream },
  filename: string,
): Response {
  const headers = new Headers();
  headers.set("Content-Type", file.type || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiFilenameFallback(filename)}"; ` +
      `filename*=UTF-8''${encodeRfc5987Filename(filename)}`,
  );
  if (typeof file.size === "number") headers.set("Content-Length", String(file.size));
  headers.set("Cache-Control", "no-store");
  // `Content-Disposition: attachment` is what keeps this route from
  // rendering anything on `api.uploads.sh` — a first-party origin, unlike
  // the bare storage hosts. These two make that a belt-and-braces claim
  // rather than the only one (issue #929 adversarial review L-2): `nosniff`
  // stops a browser re-deciding the type it was handed, and `sandbox` puts
  // the document in an opaque origin with scripting off should it ever be
  // rendered anyway. Both are inert for the attachment path every other
  // content type takes.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox");
  return new Response(file.stream(), { headers });
}
