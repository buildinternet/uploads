/**
 * Pure helpers for `invite.astro`'s join-code handling (issue #869 review
 * finding 1 — CRITICAL). Factored out of the page's inline `<script>` so the
 * security-critical part is unit-testable without a DOM: the one-time code
 * must never ride in a URL across the sign-in round trip (`callbackURL` is
 * server-visible — magic-link emails, OAuth state — the fragment browsers
 * "never send to the server" doesn't help once it's re-embedded there).
 * Instead the code is stashed in sessionStorage, scoped per invite page.
 */

/** sessionStorage key for the code stash — scoped per pageId so two invite
 * tabs (or two invites in the same tab, sequentially) don't collide. */
export function codeStorageKey(pageId: string): string {
  return `invite:${pageId}`;
}

/**
 * `/login?callbackURL=` back to this invite page — deliberately WITHOUT the
 * code, fragment or otherwise. `stashCode`/`readStashedCode` below are how
 * the join flow resumes the code on return instead.
 */
export function loginHref(origin: string, pageId: string): string {
  const returnTo = `${origin}/invite?id=${encodeURIComponent(pageId)}`;
  return `/login?callbackURL=${encodeURIComponent(returnTo)}`;
}

/** Extracts the one-time code from a URL fragment shaped `#code=...`. */
export function codeFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("code") ?? "";
}

/** The subset of the Web Storage API this module needs. */
export interface CodeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Safely accesses `window.sessionStorage`, tolerating a browser that throws
 * on the property access itself (not just on `getItem`/`setItem`) — e.g. a
 * SecurityError in some private-browsing/storage-disabled configurations.
 * Never throws; returns `null` when the getter itself throws or storage
 * isn't available, so callers can fall back to the same storage-unavailable
 * recovery path `readStashedCode`/`stashCode` already use.
 */
export function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reads and clears a code previously stashed by `stashCode`, tolerating a
 * storage that throws (private window, storage disabled) or is unavailable
 * (`null`). Never throws; returns `""` when nothing was stashed or storage
 * is unavailable.
 */
export function readStashedCode(storage: CodeStorage | null, pageId: string): string {
  if (!storage) return "";
  try {
    const key = codeStorageKey(pageId);
    const stashed = storage.getItem(key);
    if (!stashed) return "";
    storage.removeItem(key);
    return stashed;
  } catch {
    return "";
  }
}

/**
 * Stashes `code` in `storage` so it survives the round trip through
 * `/login` without ever appearing in a URL. Never throws; returns `false`
 * when storage isn't available (including a `null` storage) — callers MUST
 * NOT fall back to putting the code in a URL when this returns `false`.
 */
export function stashCode(storage: CodeStorage | null, pageId: string, code: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(codeStorageKey(pageId), code);
    return true;
  } catch {
    return false;
  }
}
