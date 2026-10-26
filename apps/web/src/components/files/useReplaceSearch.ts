import { useEffect } from "react";

/**
 * Keep the address bar's query string equal to `search` (`""` or `?…`),
 * rewriting in place with replaceState so Back leaves the page instead of
 * undoing filters. A no-op when the URL already matches, so hydration never
 * rewrites it.
 */
export function useReplaceSearch(search: string): void {
  useEffect(() => {
    const target = window.location.pathname + search;
    if (target === window.location.pathname + window.location.search) return;
    window.history.replaceState(window.history.state, "", target);
  }, [search]);
}
