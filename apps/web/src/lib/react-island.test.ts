import { describe, expect, it } from "vitest";
import { detectIdentifierPrefix } from "./react-island";

describe("detectIdentifierPrefix", () => {
  it("recovers the Astro-assigned prefix from a server-rendered useId", () => {
    const html = '<button id="base-ui-_r1R_qq_" aria-controls="base-ui-_r1R_qr_">x</button>';
    expect(detectIdentifierPrefix(html)).toBe("r1");
  });

  it("handles multi-digit prefixes and the H-suffixed useId variant", () => {
    expect(detectIdentifierPrefix('<div id="_r12R_abH2_"></div>')).toBe("r12");
  });

  it("returns empty when the markup has no server-generated useId", () => {
    expect(detectIdentifierPrefix("<div><span>plain</span></div>")).toBe("");
    expect(detectIdentifierPrefix("")).toBe("");
    // Client-format ids (`_r_0_`) are not server tree ids and must not match.
    expect(detectIdentifierPrefix('<div id="_r_0_"></div>')).toBe("");
  });
});
