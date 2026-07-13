/**
 * Client-side validation for `--meta k=v` / `meta set` pairs, mirroring the
 * server rules in `apps/api/src/file-metadata.ts` (`.context/2026-07-13-file-metadata-design.md`).
 * Validating here lets the CLI fail fast with a readable message instead of a
 * round-trip 400 — the server remains the source of truth and re-validates on
 * every write.
 */
import { UsageError } from "./cli-args.js";

/** Lowercase key, optionally dot-namespaced (e.g. `gh.repo`). Mirrors META_KEY_RE server-side. */
export const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** Max value length in characters (mirrors META_VALUE_MAX server-side). */
export const META_VALUE_MAX = 512;

/** Cap on keys per request (mirrors META_MAX_KEYS server-side). */
export const META_MAX_KEYS = 24;

/** Cap on total UTF-8 key+value bytes per request (mirrors META_MAX_TOTAL_BYTES server-side). */
export const META_MAX_TOTAL_BYTES = 8192;

// Printable ASCII only — same rule as the server's file-metadata.ts.
const VALUE_SAFE_RE = /^[\x20-\x7E]+$/;

const encoder = new TextEncoder();

/**
 * Server-computed keys the API rejects as custom metadata (currently just
 * `content-sha256`). `gh.*` is NOT reserved here: it's system-managed by
 * convention (attach flow), not blocked — the server happily accepts
 * user-supplied `gh.*` extras via `--meta`.
 */
const RESERVED_META_KEYS = new Set<string>(["content-sha256"]);

/** Throws `UsageError` with a readable message if `key`/`value` violate the metadata rules. */
export function validateMetaEntry(key: string, value: string): void {
  if (!META_KEY_RE.test(key)) {
    throw new UsageError(`invalid metadata key: "${key}" (must match ^[a-z][a-z0-9._-]{0,63}$)`);
  }
  if (RESERVED_META_KEYS.has(key)) {
    throw new UsageError(`invalid metadata key: "${key}" is reserved (server-computed)`);
  }
  if (value.length < 1 || value.length > META_VALUE_MAX || !VALUE_SAFE_RE.test(value)) {
    throw new UsageError(
      `invalid metadata value for key "${key}": must be 1-${META_VALUE_MAX} printable ASCII characters`,
    );
  }
}

/**
 * Split `k=v` on the FIRST "=" (so values may themselves contain "="), then
 * validate the pair. Throws `UsageError` on malformed input.
 */
export function parseMetaPair(raw: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    throw new UsageError(`invalid --meta value: "${raw}" (expected key=value)`);
  }
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  validateMetaEntry(key, value);
  return [key, value];
}

/**
 * Parse and validate a batch of `k=v` pairs (e.g. every `--meta` occurrence,
 * or `meta set`'s positional pairs) into a map. Fails fast on the first
 * invalid pair or when the batch exceeds `META_MAX_KEYS` or
 * `META_MAX_TOTAL_BYTES`. Later duplicate keys in the same batch win
 * (last write).
 */
export function parseMetaFlags(pairs: string[]): Record<string, string> {
  if (pairs.length > META_MAX_KEYS) {
    throw new UsageError(`too many --meta pairs: at most ${META_MAX_KEYS} per request`);
  }
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const [key, value] = parseMetaPair(pair);
    result[key] = value;
  }
  // Aggregate byte cap over the deduplicated map — same accounting as the
  // server (sum of UTF-8 key+value bytes, META_MAX_TOTAL_BYTES).
  let totalBytes = 0;
  for (const [key, value] of Object.entries(result)) {
    totalBytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }
  if (totalBytes > META_MAX_TOTAL_BYTES) {
    throw new UsageError(
      `metadata too large: ${totalBytes} bytes of keys+values exceeds the ${META_MAX_TOTAL_BYTES}-byte limit per request`,
    );
  }
  return result;
}

/**
 * Validates a pre-parsed key→value metadata map (e.g. an MCP tool's object
 * argument) against the same rules as {@link parseMetaFlags}, without
 * requiring "k=v" string parsing first. Reuses `parseMetaFlags` by
 * reconstructing "k=v" pairs — safe even when a value contains "=", since
 * `parseMetaPair` only splits on the first occurrence. Throws `UsageError`.
 */
export function validateMetaMap(meta: Record<string, string>): void {
  parseMetaFlags(Object.entries(meta).map(([key, value]) => `${key}=${value}`));
}
