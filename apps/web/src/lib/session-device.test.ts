import { describe, expect, it } from "vitest";
import { deviceLabel, formatSessionTime, isCliUserAgent } from "./session-device";

describe("isCliUserAgent", () => {
  it("recognizes the CLI user-agent prefix", () => {
    expect(isCliUserAgent("@buildinternet/uploads/0.4.2")).toBe(true);
    expect(isCliUserAgent("@buildinternet/uploads/0.4.2 (device-login)")).toBe(true);
    expect(isCliUserAgent("Mozilla/5.0 (Macintosh) Chrome/120.0")).toBe(false);
    expect(isCliUserAgent(null)).toBe(false);
    expect(isCliUserAgent("")).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("labels the CLI and common browsers", () => {
    expect(deviceLabel("@buildinternet/uploads/1.2.3")).toBe("uploads CLI 1.2.3");
    expect(deviceLabel("@buildinternet/uploads")).toBe("uploads CLI");
    expect(
      deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120"),
    ).toBe("Chrome on macOS");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Firefox/128.0")).toBe("Firefox on Windows");
    expect(deviceLabel(null)).toBe("Unknown device");
  });

  it("prefers session.cliVersion over the create-time user-agent version", () => {
    expect(deviceLabel("@buildinternet/uploads/1.0.0", { cliVersion: "1.9.0" })).toBe(
      "uploads CLI 1.9.0",
    );
    expect(deviceLabel("@buildinternet/uploads", { cliVersion: "2.0.0" })).toBe(
      "uploads CLI 2.0.0",
    );
    // Additional field alone is enough (upgrade path after UA was versionless).
    expect(deviceLabel(null, { cliVersion: "1.2.3" })).toBe("uploads CLI 1.2.3");
  });
});

describe("formatSessionTime", () => {
  it("returns an em dash for empty/invalid values", () => {
    expect(formatSessionTime(null)).toBe("—");
    expect(formatSessionTime("not-a-date")).toBe("—");
  });

  it("formats a real date", () => {
    const out = formatSessionTime("2026-07-13T12:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(4);
  });
});
