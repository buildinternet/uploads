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

/**
 * Client mirror of the API's projectLabelFromMeta (apps/api/src/file-metadata.ts)
 * — reimplemented per this page's convention; test cases pinned to the same
 * fixtures on both sides. Used to bucket search results and GitHub items
 * into their project sections.
 */
export function projectLabelFromItemMeta(meta: Record<string, string> | undefined): string {
  if (meta?.repo) return meta.repo;
  if (meta?.["gh.repo"]) return meta["gh.repo"];
  if (meta?.url) {
    try {
      const host = new URL(meta.url).host;
      if (host) return host;
    } catch {
      // unparseable url is just "no url"
    }
  }
  return "Other";
}

/**
 * Which tiles in a collection have a real before/after counterpart sitting
 * next to them. Client mirror of the API's pairing rules (before-after.ts):
 * primary rule swaps the before/after filename token and looks for that exact
 * sibling; fallback pairs a LONE before with a LONE after (the state metadata
 * declares the pairing even when filenames carry no token). Anything
 * ambiguous stays unpaired — the indicator must never claim a pair that the
 * file page won't actually show.
 */
const PAIR_TOKEN_RE = /(^|[-_.])(before|after)(?=[-_.]|$)/i;

function swapPairToken(key: string): string | null {
  // Token boundaries are -_. or the FILENAME edges (same as the API's rule) —
  // run the swap on the leaf name so a preceding `/` counts as a start.
  const slash = key.lastIndexOf("/");
  const dir = key.slice(0, slash + 1);
  const leaf = key.slice(slash + 1);
  const match = PAIR_TOKEN_RE.exec(leaf);
  if (!match) return null;
  const found = match[2]!;
  const swapped = found.toLowerCase() === "before" ? "after" : "before";
  let cased: string;
  if (found === found.toUpperCase()) cased = swapped.toUpperCase();
  else if (found[0] === found[0]!.toUpperCase())
    cased = swapped[0]!.toUpperCase() + swapped.slice(1);
  else cased = swapped;
  const start = match.index + match[1]!.length;
  return dir + leaf.slice(0, start) + cased + leaf.slice(start + found.length);
}

export function pairedShotKeys(items: Array<{ key: string; state?: string }>): Set<string> {
  const paired = new Set<string>();
  const stated = items.filter((i) => i.state === "before" || i.state === "after");
  const byKey = new Set(stated.map((i) => i.key));

  for (const item of stated) {
    const counterpartKey = swapPairToken(item.key);
    if (counterpartKey && byKey.has(counterpartKey)) paired.add(item.key);
  }

  // Token-less fallback: exactly one before and one after (neither already
  // token-paired) is an unambiguous pair.
  const loneBefore = stated.filter((i) => i.state === "before" && !paired.has(i.key));
  const loneAfter = stated.filter((i) => i.state === "after" && !paired.has(i.key));
  if (loneBefore.length === 1 && loneAfter.length === 1) {
    // Only when neither carries a token that failed to match — a token that
    // points at a missing sibling is a declared non-pair, not an ambiguity.
    if (swapPairToken(loneBefore[0]!.key) === null && swapPairToken(loneAfter[0]!.key) === null) {
      paired.add(loneBefore[0]!.key);
      paired.add(loneAfter[0]!.key);
    }
  }
  return paired;
}

/** `?project=` / `?path=` view state, "" when absent. */
export function readScreenshotsView(search: string): { project: string; path: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return { project: params.get("project") ?? "", path: params.get("path") ?? "" };
}

/** Search string for a view ("" for both clears back to the overview). */
export function screenshotsSearch(project: string, path: string): string {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (path) params.set("path", path);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
