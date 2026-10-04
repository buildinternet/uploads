import { describe, expect, it } from "vitest";
import {
  FILE_TYPE_CLASSES,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  feedItemIdFor,
  fileTypeClassFromKey,
  isInFeedScope,
} from "@uploads/comment-render/scope";
import { feedItemId } from "../src/feed-service";
import { sha256Hex } from "../src/workspace";

describe("fileTypeClassFromKey", () => {
  it("uses the same extension sets as the web shotKindFromKey", () => {
    expect([...IMAGE_EXTENSIONS]).toEqual(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
    expect([...VIDEO_EXTENSIONS]).toEqual(["mp4", "webm", "mov"]);
    expect([...FILE_TYPE_CLASSES]).toEqual(["screenshot", "video", "other"]);
  });

  it("classifies by the last extension, case-insensitively", () => {
    expect(fileTypeClassFromKey("gh/acme/app/pull/1/shot.png")).toBe("screenshot");
    expect(fileTypeClassFromKey("SHOT.JPEG")).toBe("screenshot");
    expect(fileTypeClassFromKey("x.avif")).toBe("screenshot");
    expect(fileTypeClassFromKey("clip.MOV")).toBe("video");
    expect(fileTypeClassFromKey("clip.webm")).toBe("video");
    expect(fileTypeClassFromKey("report.pdf")).toBe("other");
    expect(fileTypeClassFromKey("notes")).toBe("other");
    expect(fileTypeClassFromKey("archive.png.zip")).toBe("other");
    expect(fileTypeClassFromKey("dir.png/readme")).toBe("other");
  });
});

describe("isInFeedScope", () => {
  const scope = { repo: "acme/app", number: 7 };

  it("matches repo and number, and treats a missing number as repo-wide", () => {
    const meta = { "gh.repo": "acme/app", "gh.number": "7" };
    expect(isInFeedScope(meta, scope)).toBe(true);
    expect(isInFeedScope({ ...meta, "gh.number": "8" }, scope)).toBe(false);
    expect(isInFeedScope({ "gh.repo": "acme/app" }, { repo: "acme/app" })).toBe(true);
    expect(isInFeedScope({ "gh.repo": "acme/app" }, { repo: "acme/app", number: 0 })).toBe(true);
  });

  it("excludes promoted shadows, other repos, and a mixed-case gh.repo (writes store it lowercased, Task 2)", () => {
    expect(
      isInFeedScope({ "gh.repo": "acme/app", "gh.number": "7", "gh.status": "promoted" }, scope),
    ).toBe(false);
    expect(isInFeedScope({ "gh.repo": "acme/web", "gh.number": "7" }, scope)).toBe(false);
    expect(isInFeedScope({ "gh.number": "7" }, scope)).toBe(false);
    expect(isInFeedScope({ "gh.repo": "Acme/App", "gh.number": "7" }, scope)).toBe(false);
  });
});

describe("feedItemIdFor", () => {
  it("is the first 32 hex chars of sha256(key) and equals the API feedItemId", async () => {
    for (const key of ["gh/acme/app/pull/7/shot.png", "shots/café-née.png"]) {
      const id = await feedItemIdFor(key);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).toBe((await sha256Hex(key)).slice(0, 32));
      expect(await feedItemId(key)).toBe(id);
    }
  });
});
