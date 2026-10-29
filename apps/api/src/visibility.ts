/**
 * Per-object `visibility`, private-by-exception.
 *
 * Absence of the key (or any value other than "private") means public — the
 * historical default for every object uploaded before this existed. Follows
 * the provenance pattern (`apps/api/src/provenance.ts`): a small sanitizer
 * plus a reader, threaded through `putObject`/`headObjectJson`/`listObjects`.
 *
 * Two stores:
 *
 * - R2 custom metadata (`VISIBILITY_META_KEY`) is written on upload. A
 *   bring-your-own bucket still rewrites the object to change it, because
 *   that metadata cannot be patched in place.
 * - A hosted lane writes `VISIBILITY_ROW_KEY` instead of rewriting bytes.
 *   `private` hides the file on the API. `public` shows it even when the
 *   object metadata still says private. No row means the object metadata
 *   decides. The read gate does not read this row.
 */

export const VISIBILITY_META_KEY = "visibility";

/**
 * Hosted override in `file_metadata`. Server-owned (`ai.*`), so a client
 * tag write cannot set it. It is not a classifier label: `CLASSIFIER_ROW_KEYS`
 * does not include it, and a new upload sets the row again after that wipe.
 */
export const VISIBILITY_ROW_KEY = "ai.visibility";

export const VISIBILITY_VALUES = ["public", "private"] as const;
export type Visibility = (typeof VISIBILITY_VALUES)[number];

/** Anything other than exactly "private" collapses to `undefined` (public). */
export function sanitizeVisibility(raw: string | undefined | null): "private" | undefined {
  return raw === "private" ? "private" : undefined;
}

/** Read visibility off stored object metadata. `undefined` means public. */
export function objectVisibility(
  metadata: Record<string, string> | undefined | null,
): "private" | undefined {
  return sanitizeVisibility(metadata?.[VISIBILITY_META_KEY]);
}

/**
 * Apply a hosted `ai.visibility` row on top of object metadata.
 * Anything other than `public` or `private` leaves the object metadata as it is.
 */
export function applyVisibilityOverride(
  metadata: Record<string, string> | undefined | null,
  row: string | undefined | null,
): Record<string, string> | undefined {
  if (row !== "public" && row !== "private") return metadata ?? undefined;
  const next: Record<string, string> = metadata ? { ...metadata } : {};
  if (row === "private") next[VISIBILITY_META_KEY] = "private";
  else delete next[VISIBILITY_META_KEY];
  return next;
}
