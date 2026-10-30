/** Short-lived in-memory HTML for item pages; see item-prefetch.ts. */

/** Sent with the feed id when the visitor already has the thumbnail strip. */
export const ITEM_STRIP_HEADER = "X-Item-Strip";

const TTL_MS = 30_000;
const MAX_ENTRIES = 12;

export interface PageCache {
  /** Starts a load unless a fresh one exists; returns the pending HTML. */
  warm(key: string): Promise<string | null>;
  /** The fresh entry for `key`, if any. */
  peek(key: string): Promise<string | null> | null;
}

export function createPageCache(
  load: (key: string) => Promise<string | null>,
  now: () => number = Date.now,
): PageCache {
  const entries = new Map<string, { at: number; html: Promise<string | null> }>();
  const fresh = (key: string) => {
    const hit = entries.get(key);
    return hit && now() - hit.at < TTL_MS ? hit.html : null;
  };
  return {
    warm(key) {
      const hit = fresh(key);
      if (hit) return hit;
      const html = load(key).catch(() => null);
      entries.delete(key);
      entries.set(key, { at: now(), html });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      return html;
    },
    peek: fresh,
  };
}
