import { describe, expect, it } from "vitest";
import {
  BRAND,
  DEFAULT_TAGLINE,
  accentAt,
  formatAuthBanner,
  formatBrandHeader,
  formatUpdateBanner,
  mixRgb,
  rasterizeMark,
  renderBrandMarkLines,
} from "../src/cli-brand.js";
import { createStyle } from "../src/cli-style.js";
import { formatRootHelp } from "../src/cli-help.js";

describe("brand tokens", () => {
  it("matches design-system accent #c27eff", () => {
    expect(BRAND.accent).toEqual({ r: 0xc2, g: 0x7e, b: 0xff });
    expect(BRAND.green).toEqual({ r: 0x8f, g: 0xae, b: 0x62 });
    expect(BRAND.red).toEqual({ r: 0xd9, g: 0x8a, b: 0x9c });
  });

  it("mixes accent opacities toward panel", () => {
    expect(accentAt(1)).toEqual(BRAND.accent);
    expect(mixRgb(BRAND.accent, BRAND.panel, 0)).toEqual(BRAND.panel);
    const mid = accentAt(0.55);
    expect(mid.r).toBeGreaterThan(BRAND.panel.r);
    expect(mid.r).toBeLessThan(BRAND.accent.r);
  });
});

describe("rasterizeMark / half-block render", () => {
  it("paints three chevron opacities", () => {
    const grid = rasterizeMark();
    expect(grid.length).toBe(9);
    expect(grid[0][2]).toBe(1);
    expect(grid[8][0]).toBe(0.28);
  });

  it("emits half-block lines (not braille)", () => {
    const lines = renderBrandMarkLines({ color: false });
    expect(lines.length).toBe(5);
    expect(lines.some((l) => /[█▀▄▓░]/.test(l))).toBe(true);
    expect(lines.join("")).not.toMatch(/[\u2801-\u28FF]/);
  });

  it("uses truecolor accent when color is on", () => {
    expect(renderBrandMarkLines({ color: true }).join("\n")).toContain("\u001b[38;2;194;126;255m");
  });
});

describe("formatBrandHeader", () => {
  it("stacks label, tagline, then version", () => {
    const text = formatBrandHeader({ color: false, version: "0.9.0" });
    expect(DEFAULT_TAGLINE).toBe("GitHub screenshot + recording uploads for agents");
    expect(text).toMatch(/uploads\.sh/);
    expect(text).toMatch(DEFAULT_TAGLINE);
    expect(text).toMatch(/v0\.9\.0/);
    // version is its own line, not glued to the title
    expect(text).not.toMatch(/uploads\.sh v0\.9\.0/);
    const lines = text.trimEnd().split("\n");
    expect(lines.some((l) => l.includes("uploads.sh") && !l.includes("v0.9.0"))).toBe(true);
    expect(lines.some((l) => /v0\.9\.0/.test(l))).toBe(true);
  });
});

describe("banners", () => {
  it("update banner shows versions + install command", () => {
    const text = formatUpdateBanner({ current: "0.9.0", latest: "0.10.0", color: false });
    expect(text).toMatch(/Update available/);
    expect(text).toMatch(/0\.9\.0 → 0\.10\.0/);
    expect(text).toMatch(/uploads update/);
  });

  it("auth banner is two lines", () => {
    const text = formatAuthBanner({ color: false });
    expect(text).toMatch(/Sign in via browser/);
    expect(text).toMatch(/uploads login/);
    expect(text).not.toMatch(/Not signed in/);
  });
});

describe("createStyle brand colors", () => {
  it("uses truecolor brand palette when enabled", () => {
    const s = createStyle(true);
    expect(s.heading("Usage:")).toContain("\u001b[38;2;194;126;255m");
    expect(s.command("put")).toContain("\u001b[38;2;143;174;98m");
    expect(s.error("nope")).toContain("\u001b[38;2;217;138;156m");
  });
});

describe("formatRootHelp", () => {
  it("includes the half-block mark when color is on", () => {
    const text = formatRootHelp({ color: true, version: "0.9.0" });
    expect(text).toMatch(/uploads\.sh/);
    expect(text).toMatch(/GitHub screenshot \+ recording uploads for agents/);
    expect(text).toMatch(/v0\.9\.0/);
    expect(text).toMatch(/[█▀▄]/);
    expect(text).toContain("\u001b[38;2;194;126;255m");
  });

  it("uses a plain three-line title when color is off", () => {
    const text = formatRootHelp({ color: false, version: "0.9.0" });
    expect(text).toMatch(
      /^uploads\.sh\nGitHub screenshot \+ recording uploads for agents\nv0\.9\.0\n/,
    );
    expect(text).not.toMatch(/[█▀▄]/);
  });

  it("puts the auth banner above the title when needsAuth", () => {
    const text = formatRootHelp({ color: false, version: "0.9.0", needsAuth: true });
    expect(text.indexOf("Sign in via browser")).toBeLessThan(text.indexOf("uploads.sh"));
    expect(text).toMatch(/uploads login/);
  });

  it("omits the boxed auth banner when signed in", () => {
    const text = formatRootHelp({ color: false, version: "0.9.0", needsAuth: false });
    expect(text).not.toMatch(/┌[─]+┐\n│  Sign in via browser/);
  });

  it("shows the update banner when latestVersion is newer", () => {
    const text = formatRootHelp({
      color: false,
      version: "0.9.0",
      latestVersion: "0.10.0",
    });
    expect(text).toMatch(/Update available/);
  });
});
