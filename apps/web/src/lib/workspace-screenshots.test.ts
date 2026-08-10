import { describe, expect, it } from "vitest";
import {
  lastUpdatedLabel,
  readScreenshotsPath,
  screenshotsSearch,
  shotKindFromKey,
} from "./workspace-screenshots";

describe("shotKindFromKey", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(shotKindFromKey("shots/hero.PNG")).toBe("image");
    expect(shotKindFromKey("a/b/c.webp")).toBe("image");
    expect(shotKindFromKey("demo.mp4")).toBe("video");
    expect(shotKindFromKey("notes.pdf")).toBe("other");
    expect(shotKindFromKey("no-extension")).toBe("other");
  });
});

describe("lastUpdatedLabel", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  it("scales from minutes to a date", () => {
    expect(lastUpdatedLabel("2026-08-10T11:59:40.000Z", now)).toBe("just now");
    expect(lastUpdatedLabel("2026-08-10T11:55:00.000Z", now)).toBe("5m ago");
    expect(lastUpdatedLabel("2026-08-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(lastUpdatedLabel("2026-08-06T12:00:00.000Z", now)).toBe("4d ago");
    expect(lastUpdatedLabel("2026-07-02T12:00:00.000Z", now)).toBe("Jul 2");
  });
  it("falls back to the raw string on an unparseable date", () => {
    expect(lastUpdatedLabel("garbage", now)).toBe("garbage");
  });
});

describe("screenshots path round-trip", () => {
  it("reads ?path= and ignores its absence", () => {
    expect(readScreenshotsPath("?path=%2Fsettings")).toBe("/settings");
    expect(readScreenshotsPath("?other=1")).toBe("");
    expect(readScreenshotsPath("")).toBe("");
  });
  it("writes a search string that reads back", () => {
    expect(readScreenshotsPath(screenshotsSearch("/settings"))).toBe("/settings");
    expect(screenshotsSearch("")).toBe("");
  });
});
