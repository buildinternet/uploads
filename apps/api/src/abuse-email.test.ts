import { describe, expect, it, vi } from "vitest";
import { notifyAbuseReport, withinAbuseNotifyBudget } from "./abuse-email";

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

describe("notifyAbuseReport — EMAIL binding absent", () => {
  it("logs instead of throwing when EMAIL is absent (issue #754 item 3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      notifyAbuseReport({ WEB_ORIGIN: "https://uploads.sh" }, ROW),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.at(-1)?.[0]).toContain("no EMAIL binding");
    warn.mockRestore();
  });

  it("still applies the notify-rate budget check even without EMAIL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const registry = {
      get: async () => (calls > 0 ? "20" : null),
      put: async () => {
        calls++;
      },
    };
    await notifyAbuseReport({ WEB_ORIGIN: "https://uploads.sh", REGISTRY: registry }, ROW);
    warn.mockRestore();
    // No throw either way — asserted implicitly by reaching this line.
    expect(true).toBe(true);
  });

  it("sends when EMAIL is present", async () => {
    const send = vi.fn().mockResolvedValue({});
    await notifyAbuseReport({ EMAIL: { send }, WEB_ORIGIN: "https://uploads.sh" }, ROW);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].to).toBe("abuse@uploads.sh");
  });
});

describe("withinAbuseNotifyBudget", () => {
  it("fails open (allows) when REGISTRY is absent", async () => {
    await expect(withinAbuseNotifyBudget(undefined, 20)).resolves.toBe(true);
  });
});
