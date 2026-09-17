import { describe, expect, it } from "vitest";
import { hasAiMetadata, parseAiLabels, splitAiTags, splitFileDetailMeta } from "./ai-labels";

describe("splitAiTags", () => {
  it("splits on commas and drops empties", () => {
    expect(splitAiTags("ui,settings, dark-mode")).toEqual(["ui", "settings", "dark-mode"]);
  });

  it("dedupes and ignores blank pieces", () => {
    expect(splitAiTags("ui,,ui, ")).toEqual(["ui"]);
  });

  it("returns empty for missing or blank", () => {
    expect(splitAiTags(undefined)).toEqual([]);
    expect(splitAiTags("   ")).toEqual([]);
  });
});

describe("parseAiLabels", () => {
  it("returns null when metadata is missing", () => {
    expect(parseAiLabels(undefined)).toBeNull();
    expect(parseAiLabels(null)).toBeNull();
    expect(parseAiLabels({})).toBeNull();
  });

  it("stays silent when only ai.classifier is set", () => {
    expect(parseAiLabels({ "ai.classifier": "v2" })).toBeNull();
    expect(hasAiMetadata({ "ai.classifier": "v2" })).toBe(false);
  });

  it("reads a v2 payload", () => {
    expect(
      parseAiLabels({
        "ai.classifier": "v2",
        "ai.kind": "screenshot",
        "ai.surface": "desktop",
        "ai.screen": "login",
        "ai.tags": "auth,email-field",
        "ai.summary": "A sign-in form",
      }),
    ).toEqual({
      classifier: "v2",
      kind: "screenshot",
      surface: "desktop",
      screen: "login",
      tags: ["auth", "email-field"],
      summary: "A sign-in form",
    });
  });

  it("reads a v1 payload that has no surface or screen", () => {
    expect(
      parseAiLabels({
        "ai.classifier": "v1",
        "ai.kind": "screenshot",
        "ai.tags": "ui,settings",
        "ai.summary": "A settings page",
      }),
    ).toEqual({
      classifier: "v1",
      kind: "screenshot",
      surface: undefined,
      screen: undefined,
      tags: ["ui", "settings"],
      summary: "A settings page",
    });
  });

  it("shows tags without a classifier (partial / inherited rows)", () => {
    expect(parseAiLabels({ "ai.tags": "ui" })).toEqual({
      classifier: undefined,
      kind: undefined,
      surface: undefined,
      screen: undefined,
      tags: ["ui"],
      summary: undefined,
    });
    expect(hasAiMetadata({ "ai.tags": "ui" })).toBe(true);
  });

  it("trims values and drops blank display fields", () => {
    expect(
      parseAiLabels({
        "ai.classifier": "  v2  ",
        "ai.kind": "  ",
        "ai.screen": " settings ",
        "ai.tags": "",
      }),
    ).toEqual({
      classifier: "v2",
      kind: undefined,
      surface: undefined,
      screen: "settings",
      tags: [],
      summary: undefined,
    });
  });
});

describe("splitFileDetailMeta", () => {
  it("puts path and state first and keeps other user keys", () => {
    const split = splitFileDetailMeta({
      state: "after",
      path: "/settings",
      viewport: "1280x720",
      "image.width": "1280",
      "gh.repo": "acme/app",
      "ai.classifier": "v2",
      "ai.screen": "settings",
      "ai.kind": "screenshot",
    });
    expect(split.primary).toEqual([
      { key: "path", value: "/settings" },
      { key: "state", value: "after" },
    ]);
    expect(split.other).toEqual([
      { key: "image.width", value: "1280" },
      { key: "viewport", value: "1280x720" },
    ]);
    expect(split.ai?.screen).toBe("settings");
    expect(split.ai?.kind).toBe("screenshot");
  });

  it("omits empty primary keys and strips gh/ai from the generic list", () => {
    const split = splitFileDetailMeta({
      "gh.number": "12",
      "ai.summary": "A form",
    });
    expect(split.primary).toEqual([]);
    expect(split.other).toEqual([]);
    expect(split.ai?.summary).toBe("A form");
  });

  it("returns empty buckets when metadata is missing", () => {
    expect(splitFileDetailMeta(undefined)).toEqual({ primary: [], other: [], ai: null });
  });
});
