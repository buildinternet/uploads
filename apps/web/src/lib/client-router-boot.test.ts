/**
 * Locks in ClientRouter boot invariants that already burned us once:
 * `define:vars` + `data-astro-rerun` injects top-level `const` and throws on
 * the second account navigation, leaving stale __UPLOADS_* globals.
 * Module scripts that query the DOM must re-run on `astro:page-load` or the
 * first soft nav leaves dead chrome (empty star count, dead copy buttons, etc.).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("ClientRouter boot scripts", () => {
  const dataAstroRerunFiles = [
    "layouts/AccountLayout.astro",
    "layouts/AdminLayout.astro",
    "components/AuthIndicator.astro",
  ] as const;

  it.each(dataAstroRerunFiles)("%s does not combine define:vars with data-astro-rerun", (rel) => {
    const src = readSrc(rel);
    expect(src).toContain("data-astro-rerun");
    // `define:vars` injects top-level const and throws on the second nav.
    expect(src).not.toMatch(/define:vars\s*=/);
  });

  it("account layout assigns boot globals via set:html window assigns", () => {
    const src = readSrc("layouts/AccountLayout.astro");
    expect(src).toContain("__UPLOADS_ACTIVE_WORKSPACE__");
    expect(src).toContain("set:html=");
    expect(src).toContain("JSON.stringify");
  });

  /** Layouts / chrome that soft-nav under ClientRouter. */
  const pageLoadBoot = [
    {
      rel: "layouts/AccountLayout.astro",
      needles: ["ViewTransitions", "onAstroPageLoad"],
    },
    {
      rel: "layouts/AdminLayout.astro",
      needles: ["ViewTransitions", "onAstroPageLoad"],
    },
    {
      rel: "layouts/DocsLayout.astro",
      needles: ["ViewTransitions", "onAstroPageLoad", "bindCopyButtons", "tocSpy"],
    },
    {
      rel: "components/SiteHeader.astro",
      needles: ["onAstroPageLoad", "fillStarCount", 'getElementById("star-count")'],
    },
  ] as const;

  it.each(pageLoadBoot)(
    "$rel re-boots interactive chrome after ClientRouter swaps",
    ({ rel, needles }) => {
      const src = readSrc(rel);
      for (const needle of needles) expect(src).toContain(needle);
    },
  );
});

describe("Error page chrome", () => {
  it("ErrorLayout ships SiteHeader with auth + full site Footer", () => {
    const src = readSrc("layouts/ErrorLayout.astro");
    expect(src).toContain("SiteHeader");
    expect(src).toContain("authOrigin");
    expect(src).toContain("<Footer");
    // Full footer (not compact-only under the card) — same chrome as legal pages.
    expect(src).not.toMatch(/<Footer\s+compact/);
    expect(src).toContain("PUBLIC_UPLOADS_AUTH_ORIGIN");
  });

  it("404 and 500 use ErrorLayout", () => {
    expect(readSrc("pages/404.astro")).toContain("ErrorLayout");
    expect(readSrc("pages/500.astro")).toContain("ErrorLayout");
  });
});
