/**
 * Redirect decisions for the workspace tab moves (spec
 * `.context/2026-10-04-pr-first-workspace-and-live-links.md`, "Redirects").
 * Pure so every row of the spec's table is a unit test; the Astro pages only
 * call these and return `Astro.redirect(target, 301)`.
 *
 *   /screenshots                       → /files?view=pages (view=recent → sort=recent)
 *   /galleries                         → /links
 *   /settings/storage                  → /storage#bucket
 *   /files + old bucket-browser params → /storage?…
 *   /:name + old bucket-browser params → /storage?…, otherwise /files?…
 */

import { parseFilesView } from "./workspace-files-view";
import { workspacePath } from "./workspaces-nav";

/** Top-level Files views selected by `?view=`. */
const FILES_VIEWS = new Set(["pages", "repos"]);

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

/** `search` with one leading `?`, or "" when empty. Keeps the caller's encoding. */
function normalizeSearch(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return raw ? `?${raw}` : "";
}

/**
 * True when the query is an old bucket-browser deep link: a folder (`path`,
 * or its `prefix` alias), a filename search (`name`), a metadata filter
 * (`meta.*`), or the browser's list/grid layout (`view=list|grid`).
 */
export function isBucketBrowseSearch(search: string): boolean {
  const params = paramsOf(search);
  if (params.has("path") || params.has("prefix") || params.has("name")) return true;
  if (parseFilesView(params.get("view"))) return true;
  for (const key of params.keys()) {
    if (key.startsWith("meta.")) return true;
  }
  return false;
}

/** True when `?view=` names a Files view (`pages`, `repos`). */
export function isFilesViewSearch(search: string): boolean {
  const view = paramsOf(search).get("view");
  return view !== null && FILES_VIEWS.has(view);
}

/**
 * Where a request to `/files` goes instead, or null to render Files. A Files
 * view param (`view=pages|repos`) wins over every bucket-browser param
 * (`path`, `prefix`, `name`, `meta.*`): the By page drill-in uses `?path=`
 * for the app page path, not a bucket folder.
 */
export function filesRouteRedirect(workspace: string, search: string): string | null {
  if (isFilesViewSearch(search)) return null;
  if (!isBucketBrowseSearch(search)) return null;
  return `${workspacePath(workspace, "storage")}${normalizeSearch(search)}`;
}

export type LegacyWorkspaceRoute = "root" | "screenshots" | "galleries" | "settings-storage";

/** A `/screenshots` query as the By page view's query. */
function screenshotsToPagesSearch(search: string): string {
  const old = paramsOf(search);
  const next = new URLSearchParams();
  next.set("view", "pages");
  if (old.get("view") === "recent") next.set("sort", "recent");
  for (const [key, value] of old) {
    if (key === "view") continue;
    if (key === "sort" && next.has("sort")) continue;
    next.append(key, value);
  }
  return `?${next.toString()}`;
}

/** Destination for a retired workspace route. Always redirects. */
export function legacyWorkspaceRedirect(
  route: LegacyWorkspaceRoute,
  workspace: string,
  search: string,
): string {
  switch (route) {
    case "root":
      return (
        filesRouteRedirect(workspace, search) ??
        `${workspacePath(workspace, "files")}${normalizeSearch(search)}`
      );
    case "screenshots":
      return `${workspacePath(workspace, "files")}${screenshotsToPagesSearch(search)}`;
    case "galleries":
      return `${workspacePath(workspace, "links")}${normalizeSearch(search)}`;
    case "settings-storage":
      return `${workspacePath(workspace, "storage")}${normalizeSearch(search)}#bucket`;
  }
}
