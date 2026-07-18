/**
 * Locks in ClientRouter boot invariants that already burned us once:
 * `define:vars` + `data-astro-rerun` injects top-level `const` and throws on
 * the second account navigation, leaving stale __UPLOADS_* globals.
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
  const bootFiles = [
    "layouts/AccountLayout.astro",
    "layouts/AdminLayout.astro",
    "components/AuthIndicator.astro",
  ] as const;

  it.each(bootFiles)("%s does not combine define:vars with data-astro-rerun", (rel) => {
    const src = readSrc(rel);
    // Must re-run after body swap…
    expect(src).toContain("data-astro-rerun");
    // Attribute form only — comments may still warn about the pitfall.
    // `define:vars` injects top-level const and throws on the second nav.
    expect(src).not.toMatch(/define:vars\s*=/);
  });

  it("account layout assigns boot globals via set:html window assigns", () => {
    const src = readSrc("layouts/AccountLayout.astro");
    expect(src).toContain("__UPLOADS_ACTIVE_WORKSPACE__");
    expect(src).toContain("set:html=");
    expect(src).toContain("JSON.stringify");
  });
});
