import { describe, expect, it } from "vitest";
import { readScreenshotsView } from "../lib/workspace-screenshots";

/**
 * Plan 006: seed-prop contract for `ScreenshotsByPath`'s `initialSearch`
 * (`view`) derivation.
 *
 * This package's `vitest run` cannot import `ScreenshotsByPath.tsx` (or any
 * `.tsx` file) directly — the same limitation plan 005 documented for
 * `WorkspaceFileTable.test.ts`: `tsc --showConfig` resolves `jsx: "preserve"`
 * from `astro/tsconfigs/strict`, and plain Vitest never loads
 * `@astrojs/react`'s Vite plugin (only the full `astro dev`/`astro build`
 * pipeline does), so the raw JSX in the component reaches Rollup's
 * import-analysis unparsed and the import throws. Verified directly: an
 * ad-hoc `import("./ScreenshotsByPath")` probe under this same `vitest run`
 * fails with "Failed to parse source for import analysis... jsx: preserve".
 * No `.test.tsx` exists anywhere in this package today; standing one up
 * needs a `vitest.config.ts` wiring in a JSX-capable Vite plugin, which is
 * out of this plan's file scope.
 *
 * So this pins the *inputs* to the component's seeding, not the component's
 * render output: `ScreenshotsByPathInner`'s `view` initializer does exactly
 * `readScreenshotsView(seedSearch)`, where `seedSearch` is `initialSearch`
 * when provided, else `window.location.search` when `window` exists, else
 * `""` — see `ScreenshotsByPath.tsx`'s `seedSearch` const. `readScreenshotsView`
 * itself is already covered by `workspace-screenshots.test.ts`; what's new
 * here is asserting the exact seed value `screenshots.astro`'s
 * `initialSearch={Astro.url.search}` and a props-less (window-only) mount
 * resolve to, which is the part plan 006 actually changed.
 *
 * Unlike the files tab's `resolveFilesView`, `readScreenshotsView` never
 * reads `localStorage` (grep-verified — no `localStorage` reference anywhere
 * in `workspace-screenshots.ts` or `ScreenshotsByPath.tsx`) — it derives
 * purely from the URL search string, so there is no separate hydration-parity
 * ("stored" vs. server) contract to pin here the way plan 005 needed for the
 * files tab's `view`/`resolveFilesView`. The only parity risk was the
 * unconditional `window.location.search` read at initializer time, guarded
 * the same way plan 005 guarded `WorkspaceFileTable`'s `seedSearch`.
 *
 * `initialOverview`/`initialInfo` themselves need no seed-derivation test:
 * they're passed through `useState(() => initialOverview ?? { status:
 * "loading" })` / `useState(() => initialInfo ?? { status: "loading" })`
 * verbatim, with no parsing or URL-dependence to pin.
 */
describe("ScreenshotsByPath seed contract — initialSearch provided", () => {
  it("a default overview (empty search) seeds an empty project, path, and q", () => {
    expect(readScreenshotsView("")).toEqual({ project: "", path: "", q: "", feed: "grouped" });
  });

  it("a deep-linked project view seeds that project, no path", () => {
    expect(readScreenshotsView("?project=acme%2Fweb")).toEqual({
      project: "acme/web",
      path: "",
      q: "",
      feed: "grouped",
    });
  });

  it("a deep-linked drill-in seeds both project and path", () => {
    expect(readScreenshotsView("?project=acme%2Fweb&path=%2Fadmin")).toEqual({
      project: "acme/web",
      path: "/admin",
      q: "",
      feed: "grouped",
    });
  });

  it("a deep-linked path query seeds q without entering drill-in", () => {
    expect(readScreenshotsView("?q=%2Fcatalog")).toEqual({
      project: "",
      path: "",
      q: "/catalog",
      feed: "grouped",
    });
  });
});

describe("ScreenshotsByPath seed contract — no initialSearch prop (props-less mount)", () => {
  // Mirrors the component's own fallback: `initialSearch ?? (typeof window
  // !== "undefined" ? window.location.search : "")`. This Vitest run has no
  // `window` (Node environment, no jsdom), so the fallback resolves to `""`
  // exactly as it would during a server render with no seed prop passed —
  // the same empty-string floor the component's own guard produces.
  const seedSearch = typeof window !== "undefined" ? (window as Window).location.search : "";

  it("resolves to the same defaults today's props-less behavior always had", () => {
    expect(seedSearch).toBe("");
    expect(readScreenshotsView(seedSearch)).toEqual({
      project: "",
      path: "",
      q: "",
      feed: "grouped",
    });
  });
});
