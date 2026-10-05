/**
 * One-time "Files moved here" notice on the Storage tab (spec, "Costs and
 * risks"). A per-viewer convenience, so localStorage, and every access is
 * wrapped: private mode or blocked site data must never break the page. The
 * worst case is that the notice shows again on the next visit.
 */
export const STORAGE_MOVED_NOTICE_KEY = "uploads:storageMovedNoticeDismissed";

/** `localStorage`, or null where even reading the accessor throws. */
export function browserLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isStorageMovedNoticeDismissed(store: Pick<Storage, "getItem"> | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(STORAGE_MOVED_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissStorageMovedNotice(store: Pick<Storage, "setItem"> | null): void {
  if (!store) return;
  try {
    store.setItem(STORAGE_MOVED_NOTICE_KEY, "1");
  } catch {
    // Private mode / quota: the notice shows again on the next visit.
  }
}
