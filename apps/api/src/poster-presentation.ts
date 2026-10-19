/** Read-only poster metadata projection. No codecs or generation imports. */
import type { StorageConfig } from "@uploads/storage";
import { VIDEO_TYPES } from "./guards";
import { objectPublicUrls } from "./storage";
import type { VideoDimensions } from "./scope-wire";

/** Server-owned namespace for derived artifacts — never listed to users. */
export const POSTER_KEY_PREFIX = "_internal/posters/";

/**
 * Derived key for a video's poster. Appends `.jpg` to the *whole* key rather
 * than swapping the extension: collision-free (`clip.mp4` and `clip.webm`
 * stay distinct) and reversible.
 */
export function posterKeyFor(key: string): string {
  return `${POSTER_KEY_PREFIX}${key}.jpg`;
}

export type { VideoDimensions };

const POSITIVE_INT_RE_STRICT = /^[1-9][0-9]*$/;

/** Parses a `video.width`/`video.height` D1 string pair into positive integers, or undefined. */
export function parseVideoDimensions(
  metadata: Record<string, string>,
): VideoDimensions | undefined {
  const widthRaw = metadata["video.width"];
  const heightRaw = metadata["video.height"];
  if (!widthRaw || !heightRaw) return undefined;
  if (!POSITIVE_INT_RE_STRICT.test(widthRaw) || !POSITIVE_INT_RE_STRICT.test(heightRaw)) {
    return undefined;
  }
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined;
  return { width, height };
}

/** Video types plus PDF. Gallery and feed hydration fetch poster metadata for these. */
export function isDerivedPosterContentType(contentType: string): boolean {
  return VIDEO_TYPES.has(contentType) || contentType === "application/pdf";
}

/**
 * Derived poster URL + real video dimensions, from D1 `video.*` / `pdf.*`
 * rows. The flag is presence only — the URL is always recomputed from the
 * current storage config. A PDF reads `pdf.poster` and never publishes
 * `video.poster` or video dimensions. Every other type, including an omitted
 * content type, keeps the video-poster contract.
 */
export function videoPresentation(
  env: Env,
  cfg: StorageConfig,
  key: string,
  metadata: Record<string, string>,
  contentType?: string,
): { posterUrl?: string; videoDimensions?: VideoDimensions } {
  const pdf = contentType === "application/pdf";
  const flagged = pdf ? metadata["pdf.poster"] === "1" : metadata["video.poster"] === "1";
  const posterUrl = flagged
    ? (objectPublicUrls(env, cfg, posterKeyFor(key)).url ?? undefined)
    : undefined;
  return {
    posterUrl,
    videoDimensions: pdf ? undefined : parseVideoDimensions(metadata),
  };
}
