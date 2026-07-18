/**
 * Deep links for the account file browser:
 *   /account/workspaces/<workspace>?path=screenshots/releases/
 *
 * Legacy query form (`?ws=`) is still parsed so old links and profile
 * bookmarks keep working; new writes prefer the path-based route.
 *
 * files-sdk's FileBrowser owns navigation in React state and only offers
 * `initialPrefix` / `onSelect` — no URL sync — so the account shell wires
 * folder location into the address bar itself.
 */

/** Workspace slug shape used by the API (`apps/api` WS_NAME_RE). */
const WS_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Static segments under /account/workspaces that are not workspace slugs. */
const WORKSPACE_ROUTE_RESERVED = new Set(["new"]);

export interface BrowseLocation {
  workspace: string;
  /** Folder prefix with trailing `/`, or `""` for workspace root. */
  path: string;
}

/** True when `value` is a valid workspace name for query use. */
export function isBrowseWorkspace(value: string): boolean {
  return WS_SLUG_RE.test(value) && !WORKSPACE_ROUTE_RESERVED.has(value);
}

/**
 * Extract a workspace slug from `/account/workspaces/:name` or a nested page
 * under it (`…/:name/invite`). Returns "" for the index, create page, or
 * unrelated paths.
 */
export function workspaceFromPathname(pathname: string): string {
  const match = pathname.match(/^\/account\/workspaces\/([^/]+)(?:\/|$)/);
  if (!match) return "";
  const slug = decodeURIComponent(match[1] ?? "");
  return isBrowseWorkspace(slug) ? slug : "";
}

/**
 * Active workspace for ClientRouter account pages.
 *
 * Prefer the URL (always correct after a body swap) over the layout boot
 * global (`window.__UPLOADS_ACTIVE_WORKSPACE__`), which can lag when the
 * inline boot script fails to re-apply — the sibling-nav access error in #239.
 */
export function resolveActiveWorkspace(pathname: string, bootGlobal = ""): string {
  return workspaceFromPathname(pathname) || bootGlobal || "";
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalize a folder path for list prefixes: strip leading slashes, reject
 * `.` / `..` segments, ensure a trailing `/` when non-empty.
 */
export function normalizeBrowsePath(path: string): string {
  const trimmed = path
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!trimmed || trimmed === "/") return "";
  const segments = trimmed.replace(/\/+$/, "").split("/");
  // Reject empty / `.` / `..` segments and control chars / DEL.
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || hasControlChars(seg))) {
    return "";
  }
  return `${segments.join("/")}/`;
}

/**
 * Read workspace + folder path from the current location.
 * Prefers the path-based workspace slug; falls back to `?ws=`.
 * Pass `pathname` when not reading from `window` (tests / SSR).
 */
export function readBrowseLocation(search: string, pathname = ""): BrowseLocation {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const fromPath = pathname ? workspaceFromPathname(pathname) : "";
  const workspaceRaw = fromPath || (params.get("ws") ?? "").trim();
  const workspace = isBrowseWorkspace(workspaceRaw) ? workspaceRaw : "";
  const path = workspace ? normalizeBrowsePath(params.get("path") ?? "") : "";
  return { workspace, path };
}

/**
 * Apply browse location onto a URL. When already under
 * `/account/workspaces/:name` (or navigating to one), the workspace lives in
 * the pathname and `ws` is stripped from the query. Returns a new URL for
 * `history.replaceState`.
 */
export function applyBrowseLocation(current: URL, location: BrowseLocation): URL {
  const next = new URL(current.href);
  const workspace = isBrowseWorkspace(location.workspace) ? location.workspace : "";
  const path = workspace ? normalizeBrowsePath(location.path) : "";
  const pathWorkspace = workspaceFromPathname(next.pathname);

  if (workspace) {
    if (pathWorkspace !== workspace) {
      next.pathname = `/account/workspaces/${encodeURIComponent(workspace)}`;
    }
    next.searchParams.delete("ws");
  } else {
    next.searchParams.delete("ws");
  }
  if (path) next.searchParams.set("path", path);
  else next.searchParams.delete("path");
  return next;
}

/** Write browse location into the address bar without adding history entries. */
export function replaceBrowseLocation(location: BrowseLocation): void {
  if (typeof window === "undefined") return;
  const next = applyBrowseLocation(new URL(window.location.href), location);
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target === current) return;
  window.history.replaceState(window.history.state, "", target);
}
