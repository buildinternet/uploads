import { describe, expect, it, vi } from "vitest";
import { notifyAbuseReport } from "./abuse-email";

const ROW = {
  id: "report-1",
  reason: "spam",
  message: null,
  contact: null,
  pageUrl: "https://uploads.sh/f/abc",
  workspace: "acme",
  objectKey: "acme/file.png",
  surface: "file-page",
  createdAt: "2026-08-22T00:00:00.000Z",
};

describe("notifyAbuseReport — no-send paths", () => {
  it("logs instead of throwing when EMAIL is absent (issue #754 item 3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      notifyAbuseReport({ WEB_ORIGIN: "https://uploads.sh" }, ROW),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.at(-1)?.[0]).toContain("no EMAIL binding");
    warn.mockRestore();
  });

  it("skips the send and logs notify-rate-capped once the hourly budget is spent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue({});
    const registry = { get: async () => "20", put: vi.fn(async () => {}) };
    await notifyAbuseReport(
      { EMAIL: { send }, WEB_ORIGIN: "https://uploads.sh", REGISTRY: registry },
      ROW,
    );
    expect(send).not.toHaveBeenCalled();
    expect(registry.put).not.toHaveBeenCalled();
    expect(warn.mock.calls.at(-1)?.[0]).toContain("notify-rate-capped");
    warn.mockRestore();
  });
});
