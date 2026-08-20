/**
 * Grid vs list layout for the workspace galleries tab (`?view=grid|list`).
 *
 * Sibling of `workspace-files-view.ts`, with two deliberate differences: the
 * default is `"grid"` (the thumbnail layout is the point of this tab — a text
 * table makes it hard to tell galleries apart), and the storage key is its own
 * so switching one tab doesn't move the other. Resolution is query →
 * localStorage → `"grid"`; the toggle writes both (URL for sharing, storage
 * for return visits).
 */

export type GalleriesView = "grid" | "list";

const VIEW_PARAM = "view";
const STORAGE_KEY = "uploads:galleriesView";
const DEFAULT_VIEW: GalleriesView = "grid";

export function parseGalleriesView(value: string | null | undefined): GalleriesView | null {
  return value === "grid" || value === "list" ? value : null;
}

/** Read `view` from a query string (`?view=grid` or `view=grid`). */
export function readGalleriesViewParam(search: string): GalleriesView | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return parseGalleriesView(new URLSearchParams(raw).get(VIEW_PARAM));
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** URL wins, then storage (injectable for tests), then grid. */
export function resolveGalleriesView(
  search: string,
  stored: string | null = readStored(),
): GalleriesView {
  return readGalleriesViewParam(search) ?? parseGalleriesView(stored) ?? DEFAULT_VIEW;
}

/** Copy `current` with `view` set. Always explicit so `?view=list` overrides storage. */
export function applyGalleriesView(current: URL, view: GalleriesView): URL {
  const next = new URL(current.href);
  next.searchParams.set(VIEW_PARAM, view);
  return next;
}

/** Persist layout to localStorage + address bar (no history entry). */
export function replaceGalleriesView(view: GalleriesView): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // private mode / quota — preference is session-only then
  }
  const next = applyGalleriesView(new URL(window.location.href), view);
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== current) window.history.replaceState(window.history.state, "", target);
}
