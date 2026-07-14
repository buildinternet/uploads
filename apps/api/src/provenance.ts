/**
 * Allowlisted object provenance metadata (R2 customMetadata).
 *
 * Stored on the object at put time; echoed on put/head. Public CDN URLs serve
 * bytes only — this map is for API/operator forensics, not browser EXIF.
 *
 * Privacy: never accept tokens, auth, PII, or free-form blobs. Keys outside
 * the allowlist are dropped (not rejected) so unknown clients stay compatible.
 */

/** Max length of a single metadata value (UTF-8 bytes). */
export const PROVENANCE_VALUE_MAX = 128;

/** Max number of keys accepted per upload. */
export const PROVENANCE_KEY_MAX = 16;

/**
 * Client-supplied allowlisted keys (stored lower-case). Keep short for R2
 * metadata budget. `content-sha256` is server-computed only (not from headers).
 *
 * | key            | meaning                                      |
 * |----------------|----------------------------------------------|
 * | client         | uploader surface (uploads-cli, mcp, …)       |
 * | client-version | package/version string                       |
 * | source-name    | original filename basename                   |
 * | optimized      | "1" if client re-encoded before put          |
 * | frame          | frame id when used (phone, browser, …)       |
 * | keep-exif      | "1" if client preserved EXIF on optimize     |
 * | content-sha256 | SHA-256 of stored body (server-set)          |
 */
export const PROVENANCE_CLIENT_KEYS = [
  "client",
  "client-version",
  "source-name",
  "optimized",
  "frame",
  "keep-exif",
] as const;

/**
 * Server-computed provenance keys — never accepted from headers, and reserved
 * from the D1 custom-metadata namespace too (see file-metadata.ts's
 * `validateMetadataEntries`) so a client can't store a spoofable shadow of
 * the real integrity hash under the same name.
 */
export const PROVENANCE_SERVER_KEYS = ["content-sha256"] as const;

export const PROVENANCE_KEYS = [...PROVENANCE_CLIENT_KEYS, ...PROVENANCE_SERVER_KEYS] as const;

export type ProvenanceKey = (typeof PROVENANCE_KEYS)[number];
export type ProvenanceClientKey = (typeof PROVENANCE_CLIENT_KEYS)[number];

const ALLOWED = new Set<string>(PROVENANCE_KEYS);
const CLIENT_ALLOWED = new Set<string>(PROVENANCE_CLIENT_KEYS);

const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VALUE_SAFE_RE = /^[\x20-\x7E]+$/; // printable ASCII only

export type ProvenanceMap = Partial<Record<ProvenanceKey, string>>;

function sanitizeValue(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > PROVENANCE_VALUE_MAX) return null;
  if (!VALUE_SAFE_RE.test(v)) return null;
  return v;
}

/**
 * Keep only allowlisted keys with safe values. Unknown keys are ignored.
 * Returns undefined when the filtered map is empty.
 *
 * @param opts.clientOnly — drop server-only keys (e.g. content-sha256 from headers)
 */
export function sanitizeProvenance(
  input: Record<string, string> | undefined | null,
  opts?: { clientOnly?: boolean },
): ProvenanceMap | undefined {
  if (!input) return undefined;
  const allowed = opts?.clientOnly ? CLIENT_ALLOWED : ALLOWED;
  const out: ProvenanceMap = {};
  let n = 0;
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (n >= PROVENANCE_KEY_MAX) break;
    const key = rawKey.trim().toLowerCase();
    if (!KEY_RE.test(key) || !allowed.has(key)) continue;
    if (typeof rawVal !== "string") continue;
    const value = sanitizeValue(rawVal);
    if (!value) continue;
    out[key as ProvenanceKey] = value;
    n++;
  }
  return n > 0 ? out : undefined;
}

/**
 * Read client `X-Uploads-Meta-<key>: <value>` headers (never content-sha256).
 */
export function provenanceFromHeaders(
  getHeader: (name: string) => string | undefined,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of PROVENANCE_CLIENT_KEYS) {
    const v = getHeader(`x-uploads-meta-${key}`);
    if (v !== undefined && v !== "") raw[key] = v;
  }
  return raw;
}

const META_HEADER_PREFIX = "x-uploads-meta-";

/**
 * Split every `X-Uploads-Meta-<key>` request header into the allowlisted
 * provenance bag (stored as R2 custom metadata, unchanged) and everything
 * else (candidate custom file metadata, stored in D1 — see `file-metadata.ts`).
 * Unlike `sanitizeProvenance`, non-allowlisted keys are surfaced here rather
 * than dropped: the caller is responsible for validating and persisting them
 * (`validateMetadataEntries`/`setFileMetadata`), so bad input rejects the
 * upload instead of silently vanishing.
 */
export function splitUploadMetaHeaders(headers: Headers): {
  provenance: Record<string, string>;
  custom: Record<string, string>;
} {
  const provenance: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (!name.startsWith(META_HEADER_PREFIX)) continue;
    const key = name.slice(META_HEADER_PREFIX.length);
    if (CLIENT_ALLOWED.has(key)) {
      // Provenance keeps its historical lenience: an empty value is ignored,
      // matching provenanceFromHeaders (sanitizeProvenance drops it anyway).
      if (rawValue !== "") provenance[key] = rawValue;
    } else {
      // Custom keys must not pre-filter: empty values (and even an empty key
      // from a bare `X-Uploads-Meta-` header name) flow to
      // validateMetadataEntries so the upload rejects with a typed error
      // instead of reproducing the old silent drop.
      custom[key] = rawValue;
    }
  }
  return { provenance, custom };
}

/** Lowercase hex SHA-256 of the stored object body. */
export async function contentSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert stored metadata to a plain string map for JSON responses. */
export function provenanceForResponse(
  meta: Record<string, string> | undefined | null,
): ProvenanceMap | undefined {
  return sanitizeProvenance(meta ?? undefined);
}
