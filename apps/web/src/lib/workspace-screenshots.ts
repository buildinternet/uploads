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
  let localOrigin = false;
  if (meta?.url) {
    try {
      const parsed = new URL(meta.url);
      if (isLocalHostname(parsed.hostname)) localOrigin = true;
      else if (parsed.host) return parsed.host;
    } catch {
      // unparseable url is just "no url"
    }
  }
  if (meta?.app) return meta.app;
  return localOrigin ? "local dev" : "Other";
}

/** Hosts that identify a dev machine, not an app: any port counts the same. */
function isLocalHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "127.0.0.1" ||
    bare === "0.0.0.0" ||
    bare === "[::1]"
  );
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

/** Leaf name for captions / aria-labels — "a/b/c.png" → "c.png". */
export function leafName(key: string): string {
  const trimmed = key.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return (slash === -1 ? trimmed : trimmed.slice(slash + 1)) || key;
}

/**
 * Hover-preview caption: filename, plus a compact PR/issue line when the
 * file carries GitHub attachment metadata. Mirrors the file page's
 * filename + byline split without the native `title` tooltip.
 */
export function shotPreviewCaption(item: {
  key: string;
  ghKind?: string;
  ghNumber?: string;
  ghRef?: string;
  updatedAt?: string;
  uploadedAt?: string;
  metadata?: Record<string, string>;
}): { name: string; pr?: string; ref?: string; uploadedAt?: string } {
  const kind = item.ghKind ?? item.metadata?.["gh.kind"];
  const number = item.ghNumber ?? item.metadata?.["gh.number"];
  const repo = item.metadata?.["gh.repo"];
  // Prefer the stored `gh.ref` (already `owner/repo#n`); fall back to
  // reconstructing it so a shot with only repo+number still resolves a title.
  const ref =
    item.ghRef ?? item.metadata?.["gh.ref"] ?? (repo && number ? `${repo}#${number}` : undefined);
  const uploadedAt = item.updatedAt ?? item.uploadedAt;
  let pr: string | undefined;
  if (number) {
    if (kind === "pull") pr = `PR #${number}`;
    else if (kind === "issue" || kind === "issues") pr = `Issue #${number}`;
  }
  const caption: { name: string; pr?: string; ref?: string; uploadedAt?: string } = {
    name: leafName(item.key),
  };
  if (pr) caption.pr = pr;
  if (pr && ref) caption.ref = ref;
  if (uploadedAt) caption.uploadedAt = uploadedAt;
  return caption;
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

/** Overview layout: grouped by project/path, or one flat newest-first feed. */
export type ScreenshotsFeed = "grouped" | "recent";

export interface ScreenshotsView {
  project: string;
  path: string;
  q: string;
  feed: ScreenshotsFeed;
}

/** `?project=` / `?path=` / `?q=` / `?view=` state, ""/grouped when absent. */
export function readScreenshotsView(search: string): ScreenshotsView {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    project: params.get("project") ?? "",
    path: params.get("path") ?? "",
    q: params.get("q") ?? "",
    feed: params.get("view") === "recent" ? "recent" : "grouped",
  };
}

/** Search string for a view (all defaults clears back to the overview). */
export function screenshotsSearch(
  project: string,
  path: string,
  q = "",
  feed: ScreenshotsFeed = "grouped",
): string {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (path) params.set("path", path);
  if (q) params.set("q", q);
  if (feed === "recent") params.set("view", "recent");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * True when a project label names a GitHub repo. Labels come from
 * projectLabelFromMeta's coalesce, where only the repo branches
 * (`repo`/`gh.repo`, always "owner/name") ever contain a slash — URL hosts,
 * app names, "local dev", and "Other" never do.
 */
export function isRepoLabel(label: string): boolean {
  return label.includes("/");
}

/**
 * Autocomplete suggestions for the path filter: catalog paths matching the
 * current project + query, deduped across projects (counts summed), in the
 * catalog's own recency order. Matching is a plain substring — looser than
 * `pathQueryMatches`'s segment-prefix rule on purpose, so a half-typed
 * segment ("/ca") still surfaces "/catalog/families" to complete into.
 */
export function pathSuggestions(
  catalog: Array<{ project: string; path: string; count: number }>,
  opts: { project: string; q: string },
  limit = 8,
): Array<{ path: string; count: number }> {
  const needle = opts.q.trim().toLowerCase();
  const byPath = new Map<string, { path: string; count: number }>();
  for (const entry of catalog) {
    if (opts.project && entry.project !== opts.project) continue;
    if (needle && !entry.path.toLowerCase().includes(needle)) continue;
    const existing = byPath.get(entry.path);
    if (existing) existing.count += entry.count;
    else byPath.set(entry.path, { path: entry.path, count: entry.count });
  }
  return [...byPath.values()].slice(0, limit);
}

/**
 * Live path filter. A query that starts with `/` is a path-segment prefix
 * (`/catalog` matches `/catalog` and `/catalog/families`, not `/catalogue`).
 * Anything else is a case-insensitive substring.
 */
export function pathQueryMatches(path: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = path.toLowerCase();
  if (needle.startsWith("/")) {
    const prefix = needle.endsWith("/") ? needle.slice(0, -1) : needle;
    return haystack === prefix || haystack.startsWith(`${prefix}/`);
  }
  return haystack.includes(needle);
}

export function filterCatalog<T extends { project: string; path: string }>(
  catalog: T[],
  opts: { project: string; q: string },
): T[] {
  return catalog.filter((entry) => {
    if (opts.project && entry.project !== opts.project) return false;
    return pathQueryMatches(entry.path, opts.q);
  });
}

type PathCatalogFields = {
  project: string;
  path: string;
  count: number;
  lastUpdated: string;
};

/**
 * Join filtered catalog entries with thumbed groups. Catalog-only paths
 * (beyond the thumbed cap) render as empty `recent` strips.
 */
export function groupsFromCatalog<TRecent>(
  catalog: PathCatalogFields[],
  groups: Array<PathCatalogFields & { recent: TRecent[] }>,
): Array<PathCatalogFields & { recent: TRecent[] }> {
  const byKey = new Map(groups.map((group) => [`${group.project}\0${group.path}`, group]));
  return catalog.map((entry) => {
    const group = byKey.get(`${entry.project}\0${entry.path}`);
    if (group) return group;
    return { ...entry, recent: [] };
  });
}

type BackfillShot = {
  key: string;
  url: string | null;
  embedUrl: string | null;
  state?: string;
  ghKind?: string;
  ghNumber?: string;
};

/**
 * Thumb strip for a group past the overview's thumbed cap, built from the
 * drill-in search route's items: keep the group's own project (labels via
 * projectLabelFromItemMeta, same as the drill-in view) and reshape to the
 * by-path `recent` item, capped at the server's strip length.
 */
export function shotsFromSearchItems(
  items: Array<{
    key: string;
    url: string | null;
    embedUrl: string | null;
    metadata?: Record<string, string>;
  }>,
  project: string,
  limit = 6,
): BackfillShot[] {
  const shots: BackfillShot[] = [];
  for (const item of items) {
    if (projectLabelFromItemMeta(item.metadata) !== project) continue;
    const state = item.metadata?.state;
    const ghKind = item.metadata?.["gh.kind"];
    const ghNumber = item.metadata?.["gh.number"];
    shots.push({
      key: item.key,
      url: item.url,
      embedUrl: item.embedUrl,
      ...(state !== undefined ? { state } : {}),
      ...(ghKind !== undefined ? { ghKind } : {}),
      ...(ghNumber !== undefined ? { ghNumber } : {}),
    });
    if (shots.length === limit) break;
  }
  return shots;
}

/**
 * Which rendered groups still need a thumb backfill: no `recent` strip and
 * not already fetched (`cached` keys are `project\0path`). Capped per pass so
 * a broad filter never fans out into dozens of search requests at once.
 */
export function backfillTargets(
  groups: Array<{ project: string; path: string; recent: unknown[] }>,
  cached: Set<string>,
  limit = 12,
): Array<{ project: string; path: string }> {
  const targets: Array<{ project: string; path: string }> = [];
  for (const group of groups) {
    if (group.recent.length > 0) continue;
    if (cached.has(`${group.project}\0${group.path}`)) continue;
    targets.push({ project: group.project, path: group.path });
    if (targets.length === limit) break;
  }
  return targets;
}

/** Viewport box used to place the thumbnail hover preview. */
export type ShotPreviewBox = { left: number; top: number; right: number; bottom: number };

/**
 * Place a hover preview next to a thumbnail, flipping if it would clip the
 * viewport. Prefers the right side, then left, then below; clamps to an
 * 8px inset.
 */
export function shotPreviewPosition(
  thumb: ShotPreviewBox,
  viewport: { width: number; height: number },
  preview: { width: number; height: number },
  gap = 12,
): { left: number; top: number } {
  const inset = 8;
  const roomRight = viewport.width - inset - (thumb.right + gap);
  const roomLeft = thumb.left - gap - inset;
  let left: number;
  if (roomRight >= preview.width) left = thumb.right + gap;
  else if (roomLeft >= preview.width) left = thumb.left - gap - preview.width;
  else left = Math.max(inset, Math.min(thumb.left, viewport.width - inset - preview.width));

  let top = thumb.top;
  if (top + preview.height > viewport.height - inset) {
    top = Math.max(inset, viewport.height - inset - preview.height);
  }
  if (top < inset) top = inset;
  if (left < inset) left = inset;
  if (left + preview.width > viewport.width - inset) {
    left = Math.max(inset, viewport.width - inset - preview.width);
  }
  return { left, top };
}
