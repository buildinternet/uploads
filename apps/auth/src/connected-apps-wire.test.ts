import { describe, expect, it } from "vitest";
import { normalizeConsentScopes, toIso } from "./connected-apps-wire";

describe("normalizeConsentScopes", () => {
  it("returns a string[] as-is (dropping non-strings)", () => {
    expect(normalizeConsentScopes(["files:read", "offline_access"])).toEqual([
      "files:read",
      "offline_access",
    ]);
    expect(normalizeConsentScopes(["files:read", 1, null, "offline_access"])).toEqual([
      "files:read",
      "offline_access",
    ]);
  });

  it("parses a double-encoded JSON-array string (drizzle mode:json leftover)", () => {
    expect(normalizeConsentScopes('["files:read","offline_access"]')).toEqual([
      "files:read",
      "offline_access",
    ]);
    expect(normalizeConsentScopes('  ["files:read"]  ')).toEqual(["files:read"]);
  });

  it("splits a space-delimited OAuth scope string", () => {
    expect(normalizeConsentScopes("files:read offline_access")).toEqual([
      "files:read",
      "offline_access",
    ]);
    expect(normalizeConsentScopes("  files:read   files:write  ")).toEqual([
      "files:read",
      "files:write",
    ]);
  });

  it("never throws on garbage; empty / non-string values become []", () => {
    expect(normalizeConsentScopes(null)).toEqual([]);
    expect(normalizeConsentScopes(undefined)).toEqual([]);
    expect(normalizeConsentScopes(12)).toEqual([]);
    expect(normalizeConsentScopes("")).toEqual([]);
    expect(normalizeConsentScopes("{not-json")).toEqual(["{not-json"]);
    expect(normalizeConsentScopes("[]")).toEqual([]);
    expect(normalizeConsentScopes("[")).toEqual(["["]);
  });
});

describe("toIso", () => {
  it("treats drizzle epoch seconds as seconds, not milliseconds", () => {
    // Prod oauth_consent.created_at sample: Sep 2026 only when ×1000.
    expect(toIso(1789501808)).toBe("2026-09-15T19:50:08.000Z");
    expect(toIso("1789501808")).toBe("2026-09-15T19:50:08.000Z");
  });

  it("leaves millisecond timestamps and Date / ISO strings alone", () => {
    expect(toIso(1789501808000)).toBe("2026-09-15T19:50:08.000Z");
    expect(toIso(new Date("2026-09-15T19:50:08.000Z"))).toBe("2026-09-15T19:50:08.000Z");
    expect(toIso("2026-09-15T19:50:08.000Z")).toBe("2026-09-15T19:50:08.000Z");
  });

  it("returns null for unusable values", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso("not-a-date")).toBeNull();
    expect(toIso(Number.NaN)).toBeNull();
  });
});
