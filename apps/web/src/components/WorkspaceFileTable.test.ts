import { describe, expect, it } from "vitest";
import { readBrowseLocation } from "../lib/workspace-browse-url";
import { readSearchFilters, readSearchName } from "../lib/workspace-search-url";
import { resolveFilesView } from "../lib/workspace-files-view";

/**
 * Plan 005: seed-prop contract for `WorkspaceFileTable`'s `initialSearch`
 * (prefix/filters/nameTerm/view) derivation.
 *
 * This package's `vitest run` cannot import `WorkspaceFileTable.tsx` (or any
 * `.tsx` file) directly: `tsc --showConfig` resolves `jsx: "preserve"` from
 * `astro/tsconfigs/strict`, and plain Vitest never loads `@astrojs/react`'s
 * Vite plugin (only the full `astro dev`/`astro build` pipeline does) — so
 * the raw JSX in the component reaches Rollup's import-analysis unparsed and
 * the import throws. No `.test.tsx` exists anywhere in this package today;
 * standing one up needs a `vitest.config.ts` wiring in a JSX-capable Vite
 * plugin, which is out of this plan's file scope.
 *
 * So this pins the *inputs* to the component's seeding, not the component's
 * render output: `WorkspaceFileTable`'s `useState` initializers do exactly
 * `readBrowseLocation(seedSearch, seedPathname).path`,
 * `readSearchFilters(seedSearch)`, `readSearchName(seedSearch) ?? ""`, and
 * `resolveFilesView(seedSearch)`, where `seedSearch` is `initialSearch` when
 * provided, else `window.location.search` when `window` exists, else `""` —
 * see `WorkspaceFileTable.tsx`'s `seedSearch`/`seedPathname` consts. These
 * are the same library functions the component calls, unmodified and
 * already independently covered elsewhere (`workspace-browse-url.test.ts`,
 * `workspace-search-url.test.ts`, `workspace-files-view.test.ts`) — what's
 * new here is asserting the exact seed values `[name].astro`'s
 * `initialSearch={Astro.url.search}` and a props-less (window-only) mount
 * resolve to, which is the part plan 005 actually changed.
 */

describe("WorkspaceFileTable seed contract — initialSearch provided", () => {
  it("a default root browse (empty search) seeds an empty prefix, no filters, no name, list view", () => {
    const seedSearch = "";
    const seedPathname = "/account/workspaces/acme/files";
    expect(readBrowseLocation(seedSearch, seedPathname).path).toBe("");
    expect(readSearchFilters(seedSearch)).toEqual([]);
    expect(readSearchName(seedSearch) ?? "").toBe("");
    expect(resolveFilesView(seedSearch, null)).toBe("list");
  });

  it("a deep-linked folder path seeds that prefix", () => {
    const seedSearch = "?path=screenshots%2Freleases%2F";
    const seedPathname = "/account/workspaces/acme/files";
    expect(readBrowseLocation(seedSearch, seedPathname).path).toBe("screenshots/releases/");
  });

  it("a deep-linked search (name + meta filters) seeds filters and name, ignoring path", () => {
    const seedSearch = "?name=logo&meta.gh.repo=acme%2Frepo";
    expect(readSearchName(seedSearch)).toBe("logo");
    expect(readSearchFilters(seedSearch)).toEqual([{ key: "gh.repo", value: "acme/repo" }]);
  });

  it("?view=grid in the URL wins over stored/default", () => {
    expect(resolveFilesView("?view=grid", "list")).toBe("grid");
  });
});

describe("WorkspaceFileTable view hydration-parity contract", () => {
  // Regression guard for the view/localStorage hydration mismatch: the
  // server has no localStorage, so its render of `view` is always
  // "URL-param-or-list". `WorkspaceFileTableInner`'s `view` initializer
  // calls `resolveFilesView(seedSearch, null)` — passing `null` explicitly
  // rather than relying on `resolveFilesView`'s own localStorage-reading
  // default arg — so the client's first render (before the mount-once
  // effect that applies the *real* stored preference) matches the server
  // bit-for-bit regardless of what's in the visiting browser's
  // localStorage. If this ever regresses back to a bare
  // `resolveFilesView(seedSearch)` call, a user with `"grid"` stored would
  // hydrate onto server-rendered list markup and React would discard +
  // regenerate the whole tree client-side (a visible flash plus a
  // hydration-mismatch console error) on every load and warm nav.
  it("with no stored preference and no URL param, resolves list — storage plays no part", () => {
    expect(resolveFilesView("", null)).toBe("list");
  });

  it("a ?view= URL param still wins over the (ignored) stored preference", () => {
    expect(resolveFilesView("?view=grid", null)).toBe("grid");
  });
});

describe("WorkspaceFileTable seed contract — no initialSearch prop (props-less mount)", () => {
  // Mirrors the component's own fallback: `initialSearch ?? (typeof window
  // !== "undefined" ? window.location.search : "")`. This Vitest run has no
  // `window` (Node environment, no jsdom), so the fallback resolves to `""`
  // exactly as it would during a server render with no seed prop passed —
  // the same empty-string floor the component's own guard produces.
  const seedSearch = typeof window !== "undefined" ? (window as Window).location.search : "";

  it("resolves to the same defaults today's props-less behavior always had", () => {
    expect(seedSearch).toBe("");
    expect(readBrowseLocation(seedSearch, "").path).toBe("");
    expect(readSearchFilters(seedSearch)).toEqual([]);
    expect(readSearchName(seedSearch)).toBeUndefined();
    expect(resolveFilesView(seedSearch, null)).toBe("list");
  });
});
