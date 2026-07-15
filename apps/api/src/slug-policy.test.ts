import { describe, expect, it } from "vitest";
import { validateSlug } from "./slug-policy";

describe("validateSlug", () => {
  it("accepts ordinary slugs", () => {
    for (const s of ["zach", "my-project-2", "buildinternet"]) {
      expect(validateSlug(s)).toEqual({ ok: true });
    }
  });
  it("rejects malformed slugs as invalid_workspace_name", () => {
    for (const s of ["", "A", "-lead", "x", "café", "a".repeat(64)]) {
      expect(validateSlug(s)).toEqual({ ok: false, code: "invalid_workspace_name" });
    }
  });
  it("rejects reserved names with reserved_workspace_name", () => {
    for (const s of ["default", "admin", "api", "storage", "me"]) {
      expect(validateSlug(s)).toEqual({ ok: false, code: "reserved_workspace_name" });
    }
  });
  it("rejects blocklisted terms as plain invalid_workspace_name (no distinct code)", () => {
    // Real entries from the vendored LDNOOBW list (mild profanity, for test
    // readability); hyphens/digits must not defeat the match.
    expect(validateSlug("my-shit-workspace")).toEqual({
      ok: false,
      code: "invalid_workspace_name",
    });
    expect(validateSlug("boob-team")).toEqual({ ok: false, code: "invalid_workspace_name" });
    // Digit-lookalike folding: "5hit" -> "shit".
    expect(validateSlug("5hit-team")).toMatchObject({ ok: false });
  });
  it("allows Scunthorpe-style false positives", () => {
    for (const s of ["scunthorpe", "assets-team", "classic-cars", "grape", "analytics"]) {
      expect(validateSlug(s)).toEqual({ ok: true });
    }
  });
  it("rejects a standalone blocklist term even when an allowlisted word appears elsewhere in the slug", () => {
    for (const s of ["grape-rape", "canal-anal", "analytics-anal"]) {
      expect(validateSlug(s)).toEqual({ ok: false, code: "invalid_workspace_name" });
    }
  });
});
