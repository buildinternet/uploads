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
 * Allowlisted keys (stored lower-case). Keep short for R2 metadata budget.
 *
 * | key            | meaning                                      |
 * |----------------|----------------------------------------------|
 * | client         | uploader surface (uploads-cli, mcp, …)       |
 * | client-version | package/version string                       |
 * | source-name    | original filename basename                   |
 * | optimized      | "1" if client re-encoded before put          |
 * | frame          | frame id when used (phone, browser, …)       |
 * | keep-exif      | "1" if client preserved EXIF on optimize     |
 */
export const PROVENANCE_KEYS = [
  "client",
  "client-version",
  "source-name",
  "optimized",
  "frame",
  "keep-exif",
] as const;

export type ProvenanceKey = (typeof PROVENANCE_KEYS)[number];

const ALLOWED = new Set<string>(PROVENANCE_KEYS);

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
 */
export function sanitizeProvenance(
  input: Record<string, string> | undefined | null,
): ProvenanceMap | undefined {
  if (!input) return undefined;
  const out: ProvenanceMap = {};
  let n = 0;
  for (const [rawKey, rawVal] of Object.entries(input)) {
    if (n >= PROVENANCE_KEY_MAX) break;
    const key = rawKey.trim().toLowerCase();
    if (!KEY_RE.test(key) || !ALLOWED.has(key)) continue;
    if (typeof rawVal !== "string") continue;
    const value = sanitizeValue(rawVal);
    if (!value) continue;
    out[key as ProvenanceKey] = value;
    n++;
  }
  return n > 0 ? out : undefined;
}

/**
 * Read `X-Uploads-Meta-<key>: <value>` request headers into a raw map
 * (pre-sanitize). Header names are case-insensitive.
 */
export function provenanceFromHeaders(
  getHeader: (name: string) => string | undefined,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of PROVENANCE_KEYS) {
    const v = getHeader(`x-uploads-meta-${key}`);
    if (v !== undefined && v !== "") raw[key] = v;
  }
  return raw;
}

/** Convert stored metadata to a plain string map for JSON responses. */
export function provenanceForResponse(
  meta: Record<string, string> | undefined | null,
): ProvenanceMap | undefined {
  return sanitizeProvenance(meta ?? undefined);
}
