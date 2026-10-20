import { describe, expect, it } from "vitest";
import { matchingSkipLabel, requirementChecklist, surfaceOf } from "./github-check-requirements";

describe("surfaceOf", () => {
  it("prefers the classifier's label", () => {
    expect(
      surfaceOf({ "ai.surface": "mobile", "image.width": "2880", "image.height": "1800" }),
    ).toBe("mobile");
  });

  it("falls back to the frame's shape", () => {
    expect(surfaceOf({ "image.width": "1170", "image.height": "2532" })).toBe("mobile");
    expect(surfaceOf({ "video.width": "1920", "video.height": "1080" })).toBe("desktop");
    expect(surfaceOf({ "ai.surface": "tablet", "image.width": "800", "image.height": "800" })).toBe(
      null,
    );
    expect(surfaceOf(undefined)).toBe(null);
  });
});

describe("requirementChecklist", () => {
  it("evaluates each requirement in order", () => {
    expect(
      requirementChecklist(["uploads", "before-after", "desktop", "mobile"], 2, [
        { state: "before", "image.width": "1440", "image.height": "900" },
        { state: "after" },
      ]),
    ).toEqual([
      { label: "Uploads", met: true },
      { label: "Before and after", met: true },
      { label: "Desktop", met: true },
      { label: "Mobile", met: false },
    ]);
  });

  it("counts galleries and held files as uploads", () => {
    expect(requirementChecklist(["uploads"], 1, [])).toEqual([{ label: "Uploads", met: true }]);
    expect(requirementChecklist(["uploads"], 0, [])).toEqual([{ label: "Uploads", met: false }]);
  });
});

describe("matchingSkipLabel", () => {
  it("matches case-insensitively and returns the PR's spelling", () => {
    expect(matchingSkipLabel(["bug", "Skip-Uploads"], ["skip-uploads"])).toBe("Skip-Uploads");
    expect(matchingSkipLabel(["bug"], ["skip-uploads"])).toBe(null);
  });
});
