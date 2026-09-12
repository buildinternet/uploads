import { createElement, type ComponentType } from "react";
import { hydrateRoot, type Root } from "react-dom/client";

/**
 * Manual-island hydration helper (`client:*` is banned repo-wide; see
 * astro.config.mjs, so React components are SSR'd plain and `hydrateRoot`-ed
 * from page/layout scripts).
 *
 * Astro's React renderer gives every server-rendered component on a page an
 * incrementing `identifierPrefix` (`r0`, `r1`, … — @astrojs/react server.js),
 * which React folds into every `useId` value (`_r1R_qq_`). A `client:*`
 * island carries that prefix to the client on its `<astro-island>` wrapper,
 * but a manual mount has no wrapper to read it from — hydrating with the
 * default empty prefix makes every useId-bearing node (base-ui dropdown and
 * tooltip triggers, form field ids) mismatch and log hydration errors, and
 * the ids are regenerated instead of adopted. The prefix is recoverable from
 * the server markup itself: every SSR'd useId embeds it as `_<prefix>R_…_`.
 */

/** Matches the prefix inside a server-generated React useId (`_r1R_qq_` → `r1`). */
const SSR_USE_ID_RE = /_(r\d+)R_[0-9a-v]/;

/**
 * The `identifierPrefix` the server render used inside `html`, or `""` when
 * none is detectable (component renders no useId — empty prefix is then
 * harmless). Pass the mount's `innerHTML` before calling `hydrateRoot`, and
 * hand the result to its `identifierPrefix` option.
 */
export function detectIdentifierPrefix(html: string): string {
  return SSR_USE_ID_RE.exec(html)?.[1] ?? "";
}

export interface IslandMounterOptions<P extends object> {
  /** id of the element wrapping the SSR'd island markup. */
  mountId: string;
  /** id of the `<script type="application/json">` carrying the seed props. */
  seedId: string;
  /**
   * Lazily resolves the component to hydrate. Keep the `import()` specifier
   * inline (`() => import("./X").then((m) => m.X)`) so the bundler can still
   * code-split it — a static top-level import would defeat the point, and a
   * dev Fast-Refresh glitch in one island shouldn't block the page's other
   * scripts.
   */
  load: () => Promise<ComponentType<P>>;
}

/**
 * Builds the boot function for a manually-hydrated island, factoring the
 * read-seed → teardown-on-swap → lazy-import → `hydrateRoot` lifecycle that
 * every mount site otherwise hand-writes. Call once at a `<script>`'s top
 * level (so its `root` persists across ClientRouter soft-navs) and invoke the
 * returned boot from `onAstroPageLoad` — which fires on first load and on
 * every nav, so one registration both mounts and remounts.
 *
 * Returns without mounting when the element or seed is absent (a page that
 * doesn't carry this island), so a layout can call it unconditionally. The
 * component must compose its own `IslandErrorBoundary`, as the app's islands
 * do, so the hydrated tree matches the SSR'd markup exactly.
 */
export function createIslandMounter<P extends object>(
  opts: IslandMounterOptions<P>,
): () => Promise<void> {
  let root: Root | null = null;

  function teardown(): void {
    if (!root) return;
    try {
      root.unmount();
    } catch {
      // Container may already be gone after a body swap.
    }
    root = null;
  }

  return async function boot(): Promise<void> {
    const mount = document.getElementById(opts.mountId);
    const seedEl = document.getElementById(opts.seedId);
    if (!mount || !seedEl?.textContent) return;
    let seed: P;
    try {
      seed = JSON.parse(seedEl.textContent) as P;
    } catch {
      return;
    }
    // Tear down before Astro swaps the body away. {once:true} auto-clears, so
    // repeated astro:page-load events from ClientRouter never stack listeners.
    document.addEventListener("astro:before-swap", teardown, { once: true });
    const Component = await opts.load();
    if (!document.contains(mount)) return;
    teardown();
    root = hydrateRoot(mount, createElement(Component, seed), {
      identifierPrefix: detectIdentifierPrefix(mount.innerHTML),
    });
  };
}
