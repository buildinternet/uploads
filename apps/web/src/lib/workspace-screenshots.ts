/**
 * Pure view helpers for the screenshots-by-path page (ScreenshotsByPath.tsx).
 * The `by-path` payload has no contentType (it comes from D1, not a storage
 * list), so media kind is inferred from the key's extension — same trade-off
 * the search results accept.
 */

export type ShotKind = "image" | "video" | "other";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

export function shotKindFromKey(key: string): ShotKind {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  const ext = match?.[1]?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact recency label for a group header. Unparseable input passes through. */
export function lastUpdatedLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${MONTHS[then.getUTCMonth()]} ${then.getUTCDate()}`;
}

/** `?path=` drill-in value, "" when absent. */
export function readScreenshotsPath(search: string): string {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("path") ?? "";
}

/** Search string for a drill-in URL ("" clears back to the overview). */
export function screenshotsSearch(path: string): string {
  if (!path) return "";
  const params = new URLSearchParams();
  params.set("path", path);
  return `?${params.toString()}`;
}
