/**
 * Faster prev/next on public item pages (/c/<feed>/<item>, /g/<gallery>/<item>).
 *
 * The pages are `no-store`, so the browser drops any prefetch and every move
 * waits on a fresh SSR round trip. Instead the neighbours' HTML is fetched
 * into memory for a short while and handed to ClientRouter when the visitor
 * moves, and their main image is warmed so it paints from cache. Nothing is
 * written to the HTTP cache, and a failed load falls back to ClientRouter's own
 * fetch.
 *
 * The live-link thumbnail strip stays on screen across moves
 * (`transition:persist`). When the target is in it, the request carries
 * `X-Item-Strip: <feed id>` and the page skips re-reading the whole feed,
 * sending an empty strip that the kept one replaces.
 */
import type { TransitionBeforePreparationEvent } from "astro:transitions/client";
import { createPageCache, ITEM_STRIP_HEADER } from "./item-page-cache";

/** The feed id when the current page's strip already links to `href`. */
function stripFor(href: string): string | null {
  const strip = document.querySelector<HTMLElement>("[data-item-strip]");
  const path = new URL(href).pathname;
  if (!strip?.dataset.itemStrip) return null;
  const known = [...strip.querySelectorAll<HTMLAnchorElement>("a")].some(
    (link) => link.pathname === path,
  );
  return known ? strip.dataset.itemStrip : null;
}

// Keyed by strip too: a strip-less page must not reuse an empty-strip response.
function cacheKey(href: string): string {
  return `${stripFor(href) ?? ""} ${href}`;
}

async function loadPage(key: string): Promise<string | null> {
  const [strip, href] = key.split(" ", 2);
  const headers: Record<string, string> = { Accept: "text/html" };
  if (strip) headers[ITEM_STRIP_HEADER] = strip;
  const res = await fetch(href, { headers });
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
  void cache.warm(cacheKey(link.href));
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
  if (!document.querySelector("[data-item-navigation]")) return;
  if (prep.to.origin !== location.origin || !/^\/[cg]\//.test(prep.to.pathname)) return;
  const key = cacheKey(prep.to.href);
  const pending = cache.peek(key) ?? cache.warm(key);
  const original = prep.loader;
  prep.loader = async () => {
    const html = await pending;
    if (html === null || prep.signal.aborted) return original();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("noscript").forEach((el) => el.remove());
    prep.newDocument = doc;
  };
});

// The kept strip still marks the item it was rendered for.
document.addEventListener("astro:after-swap", () => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-item-strip] a")) {
    const current = link.pathname === location.pathname;
    link.classList.toggle("current", current);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
});
