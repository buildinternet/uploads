/**
 * Detect and surface a failed <img> / <video> load on the public media
 * stages. The file record can be fine while the bytes 404, fail to decode,
 * or never arrive — the browser's broken-image icon is not a UI.
 *
 * Direct binders (ImagePreview, MediaStage) call `bindMediaLoadError`.
 * Gallery grid roots opt in with `data-media-load` + a hidden
 * `[data-media-fallback]` sibling and are wired by `bindMediaFallbacks`.
 */

export const MEDIA_PREVIEW_FAILED_TITLE = "Preview failed";

export function mediaPreviewFailedBody(kind: "image" | "video"): string {
  return kind === "video"
    ? "The file is stored, but this video could not be played."
    : "The file is stored, but this image could not be displayed.";
}

/** True when the image has finished and produced no bitmap (error or empty). */
export function imageLoadFailed(img: { complete: boolean; naturalWidth: number }): boolean {
  return img.complete && img.naturalWidth === 0;
}

/** Mark the stage failed and reveal its fallback. Returns false if already marked. */
export function applyMediaFailure(root: HTMLElement): boolean {
  if (root.dataset.failed === "1") return false;
  root.dataset.failed = "1";
  const fallback = root.querySelector<HTMLElement>("[data-media-fallback]");
  if (fallback) fallback.hidden = false;
  return true;
}

export function bindMediaLoadError(
  root: HTMLElement,
  media: HTMLImageElement | HTMLVideoElement,
  onFailed?: () => void,
): void {
  const fail = () => {
    if (!applyMediaFailure(root)) return;
    onFailed?.();
  };
  if (media instanceof HTMLImageElement) {
    if (media.complete) {
      if (imageLoadFailed(media)) fail();
      return;
    }
    media.addEventListener("error", fail, { once: true });
    return;
  }
  if (media.error) {
    fail();
    return;
  }
  media.addEventListener("error", fail, { once: true });
}

/** Bind every `[data-media-load]` root under `scope` that hasn't been bound yet. */
export function bindMediaFallbacks(scope: ParentNode = document): void {
  for (const root of scope.querySelectorAll<HTMLElement>("[data-media-load]")) {
    if (root.dataset.mediaBound === "1") continue;
    root.dataset.mediaBound = "1";
    const media = root.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    if (!media) continue;
    bindMediaLoadError(root, media);
  }
}
