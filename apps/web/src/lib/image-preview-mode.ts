/**
 * Fit vs full-width for public image previews.
 * Tall images (height/width ≥ threshold) default to full so screenshots stay readable.
 */

export type ImagePreviewMode = "fit" | "full";

/** Height/width at or above this → prefer full width when no override. */
export const TALL_ASPECT_RATIO = 1.35;

export function isTallImage(
  naturalWidth: number,
  naturalHeight: number,
  ratio = TALL_ASPECT_RATIO,
): boolean {
  return naturalWidth > 0 && naturalHeight > 0 && naturalHeight / naturalWidth >= ratio;
}

/** In-page override wins; otherwise tall → full, else fit. */
export function resolvePreviewMode(opts: {
  override: ImagePreviewMode | null;
  naturalWidth: number;
  naturalHeight: number;
}): ImagePreviewMode {
  if (opts.override) return opts.override;
  return isTallImage(opts.naturalWidth, opts.naturalHeight) ? "full" : "fit";
}
