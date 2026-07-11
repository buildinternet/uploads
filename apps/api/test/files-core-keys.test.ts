import { describe, expect, it } from "vitest";
import { governUploadKey, sanitizeKeyBasename } from "../src/files-core";

describe("governUploadKey", () => {
  it("prefixes bare basenames", () => {
    const key = governUploadKey("shot.png");
    expect(key).toMatch(/^f\/[A-Za-z0-9_-]+\/shot\.png$/);
  });

  it("leaves nested keys unchanged", () => {
    expect(governUploadKey("screenshots/app/1/shot.png")).toBe("screenshots/app/1/shot.png");
    expect(governUploadKey("gh/o/r/pull/1/a.png")).toBe("gh/o/r/pull/1/a.png");
  });

  it("can disable auto-prefix", () => {
    expect(governUploadKey("shot.png", false)).toBe("shot.png");
  });

  it("sanitizes basename characters", () => {
    expect(sanitizeKeyBasename("my shot!!.png")).toBe("my-shot-.png");
  });
});
