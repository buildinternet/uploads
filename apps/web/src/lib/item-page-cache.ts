/** Short-lived in-memory HTML for item pages; see item-prefetch.ts. */
const TTL_MS = 30_000;
const MAX_ENTRIES = 12;

export interface PageCache {
  /** Starts a load unless a fresh one exists; returns the pending HTML. */
  warm(href: string): Promise<string | null>;
  /** The fresh entry for `href`, if any. */
  peek(href: string): Promise<string | null> | null;
}

export function createPageCache(
  load: (href: string) => Promise<string | null>,
  now: () => number = Date.now,
): PageCache {
  const entries = new Map<string, { at: number; html: Promise<string | null> }>();
  const fresh = (href: string) => {
    const hit = entries.get(href);
    return hit && now() - hit.at < TTL_MS ? hit.html : null;
  };
  return {
    warm(href) {
      const hit = fresh(href);
      if (hit) return hit;
      const html = load(href).catch(() => null);
      entries.delete(href);
      entries.set(href, { at: now(), html });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      return html;
    },
    peek: fresh,
  };
}
