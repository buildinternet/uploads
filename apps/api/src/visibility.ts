/**
 * Per-object `visibility` (R2 custom metadata), private-by-exception.
 *
 * Absence of the key (or any value other than "private") means public — the
 * historical default for every object uploaded before this existed. Follows
 * the provenance pattern (`apps/api/src/provenance.ts`): a small sanitizer
 * plus a reader, threaded through `putObject`/`headObjectJson`/`listObjects`.
 */

export const VISIBILITY_META_KEY = "visibility";

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
