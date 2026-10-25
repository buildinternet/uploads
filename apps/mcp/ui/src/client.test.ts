import { describe, expect, it } from "vitest";
import { mediaPage, needsScope, safePreviewUrl, scopeFrom, scopeKey, scopePage } from "./client";

describe("staged tray client boundaries", () => {
  it("keeps explicit repository and branch together", () => {
    expect(scopeFrom({ repo: "example/studio" })).toBeNull();
    expect(scopeFrom({ repo: "example/studio", branch: " " })).toBeNull();
    expect(scopeKey({ repo: "Example/Studio", branch: "Feature" })).toBe(
      '["example/studio","feature"]',
    );
    expect(scopeKey({ repo: "example/studio", branch: "one" })).not.toBe(
      scopeKey({ repo: "example/studio", branch: "two" }),
    );
  });

  it("does not convert authorization errors or malformed results into an empty tray", () => {
    expect(() =>
      mediaPage({
        isError: true,
        content: [{ type: "text", text: "Reconnect Uploads: files:read is required." }],
      }),
    ).toThrow("files:read");
    expect(() =>
      mediaPage({
        structuredContent: { repo: "example/studio", branch: "one", items: [{}], cursor: null },
      }),
    ).toThrow("invalid staged-media");
    expect(needsScope({ structuredContent: { needsScope: true } })).toBe(true);
  });

  it("preserves continuation through an empty media or scope page", () => {
    expect(
      mediaPage({
        structuredContent: { repo: "example/studio", branch: "one", items: [], cursor: "continue" },
      }).cursor,
    ).toBe("continue");
    expect(scopePage({ structuredContent: { scopes: [], cursor: "continue" } }).cursor).toBe(
      "continue",
    );
  });

  it("does not load credentials, arbitrary origins, or active content from preview URLs", () => {
    expect(safePreviewUrl("https://embed.uploads.sh/workspace/screenshot.png")).toBe(
      "https://embed.uploads.sh/workspace/screenshot.png",
    );
    for (const url of [
      "https://evil.example/a.png",
      "https://embed.uploads.sh.evil.example/a.png",
      "https://token@embed.uploads.sh/a.png",
      "https://embed.uploads.sh:444/a.png",
      "http://embed.uploads.sh/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
    ]) {
      expect(safePreviewUrl(url)).toBeNull();
    }
  });
});
