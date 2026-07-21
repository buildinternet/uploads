/**
 * List vs grid layout for the workspace files tab (`?view=list|grid`).
 *
 * Resolution: query → localStorage → `"list"`. Toggle writes both (URL for
 * sharing, storage for return visits). Browse/search writers leave `view`
 * alone, so folder/filter navigation keeps the layout.
 */

export type FilesView = "list" | "grid";

const VIEW_PARAM = "view";
const STORAGE_KEY = "uploads:filesView";

export function parseFilesView(value: string | null | undefined): FilesView | null {
  return value === "list" || value === "grid" ? value : null;
}

/** Read `view` from a query string (`?view=grid` or `view=grid`). */
export function readFilesViewParam(search: string): FilesView | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return parseFilesView(new URLSearchParams(raw).get(VIEW_PARAM));
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** URL wins, then storage (injectable for tests), then list. */
export function resolveFilesView(search: string, stored: string | null = readStored()): FilesView {
  return readFilesViewParam(search) ?? parseFilesView(stored) ?? "list";
}

/** Copy `current` with `view` set. Always explicit so `?view=list` overrides storage. */
export function applyFilesView(current: URL, view: FilesView): URL {
  const next = new URL(current.href);
  next.searchParams.set(VIEW_PARAM, view);
  return next;
}

/** Persist layout to localStorage + address bar (no history entry). */
export function replaceFilesView(view: FilesView): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // private mode / quota — preference is session-only then
  }
  const next = applyFilesView(new URL(window.location.href), view);
  const target = `${next.pathname}${next.search}${next.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (target !== current) window.history.replaceState(window.history.state, "", target);
}
