/**
 * Guards the sign-in-wrap consent notice (components/LegalConsent.astro).
 *
 * Why a source-level test rather than a rendered-DOM one: this app has no
 * harness that renders `.astro` to HTML in a unit test (see
 * pages-reachability.test.ts for the same constraint), and the regression
 * actually worth catching is coarse — someone refactors a sign-in page and
 * the notice quietly stops rendering. Reading the source catches exactly
 * that, without a build step.
 *
 * The stakes are legal, not cosmetic. The Terms' opening line is browsewrap
 * on its own; this notice is what puts the agreement in front of the action
 * that creates the account. If a page below ever stops rendering it, that is
 * a compliance regression, so the fix is to restore the notice — not to
 * delete the case from this list.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new NodeURL(relativePath, import.meta.url)), "utf8");
}

describe("LegalConsent component", () => {
  const component = source("./components/LegalConsent.astro");

  it("links to both policies", () => {
    expect(component).toContain('href="/terms"');
    expect(component).toContain('href="/privacy"');
  });

  it("states that continuing is the act of agreement", () => {
    expect(component).toContain("By continuing, you agree to the");
  });

  it("keeps explicit spaces around the policy links", () => {
    // A bare newline between text and `<a>` collapses to no space in the
    // rendered HTML (same bite as the legal pages). Explicit `{" "}` keeps
    // the spaces even when Prettier wraps the markup.
    expect(component).toContain('the{" "}');
    expect(component).toContain('{" "}and{" "}');
    expect(component).toContain('href="/terms"');
    expect(component).toContain('href="/privacy"');
  });
});

describe.each([
  { page: "/login", path: "./pages/login.astro", importPath: "../components/LegalConsent.astro" },
  {
    page: "/device",
    path: "./pages/device.astro",
    importPath: "../components/LegalConsent.astro",
  },
  {
    page: "/accept-invitation/[id]",
    path: "./pages/accept-invitation/[id].astro",
    importPath: "../../components/LegalConsent.astro",
  },
])("$page shows the consent notice", ({ path, importPath }) => {
  const page = source(path);

  it("imports the component", () => {
    expect(page).toContain(`import LegalConsent from "${importPath}"`);
  });

  it("renders it", () => {
    expect(page).toContain("<LegalConsent />");
  });
});
