/**
 * Faster prev/next on public item pages (/c/<feed>/<item>, /g/<gallery>/<item>).
 *
 * The pages are `no-store`, so the browser drops any prefetch and every move
 * waits on a fresh SSR round trip. Instead the neighbours' HTML is fetched
 * into memory for a short while and handed to ClientRouter when the visitor
 * moves, and their main image is warmed so it paints from cache. Nothing is
 * written to the HTTP cache, and a miss falls back to ClientRouter's own fetch.
 */
import type { TransitionBeforePreparationEvent } from "astro:transitions/client";
import { createPageCache } from "./item-page-cache";

async function loadPage(href: string): Promise<string | null> {
  const res = await fetch(href, { headers: { Accept: "text/html" } });
  if (!res.ok || res.redirected) return null;
  if (!(res.headers.get("Content-Type") ?? "").startsWith("text/html")) return null;
  const html = await res.text();
  const image = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector<HTMLImageElement>("img.single-image");
  if (image?.src) new Image().src = image.src;
  return html;
}

const cache = createPageCache(loadPage);

function warm(link: HTMLAnchorElement): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData || link.origin !== location.origin) return;
  if (link.href === location.href) return;
  void cache.warm(link.href);
}

// Prev/next are the likely next move, so they load once the page is idle.
document.addEventListener("astro:page-load", () => {
  const links = document.querySelectorAll<HTMLAnchorElement>("[data-item-navigation] a[rel]");
  if (links.length === 0) return;
  const run = () => links.forEach(warm);
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 200);
});

// Any other item link (the thumbnail strip) loads on hover, focus or press.
for (const type of ["pointerover", "focusin", "pointerdown"] as const) {
  document.addEventListener(
    type,
    (event) => {
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[data-item-prefetch]")
          : null;
      if (link) warm(link);
    },
    { passive: true },
  );
}

document.addEventListener("astro:before-preparation", (event) => {
  const prep = event as TransitionBeforePreparationEvent;
  if (prep.formData) return;
  const pending = cache.peek(prep.to.href);
  if (!pending) return;
  const original = prep.loader;
  prep.loader = async () => {
    const html = await pending;
    if (html === null || prep.signal.aborted) return original();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("noscript").forEach((el) => el.remove());
    prep.newDocument = doc;
  };
});
