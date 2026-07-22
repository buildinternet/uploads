import { describe, expect, it, vi } from "vitest";
import { sendWelcomeEmail } from "./welcome-email";

describe("sendWelcomeEmail", () => {
  it("logs instead of throwing when EMAIL is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      sendWelcomeEmail(
        { WEB_ORIGIN: "https://uploads.sh" },
        { to: "a@example.com", workspaceName: "acme" },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Welcome to uploads.sh");
    warn.mockRestore();
  });

  it("sends from noreply@uploads.sh with the welcome template", async () => {
    const send = vi.fn().mockResolvedValue({});
    await sendWelcomeEmail(
      { EMAIL: { send }, WEB_ORIGIN: "https://uploads.sh" },
      { to: "new@example.com", workspaceName: "acme" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]?.[0];
    expect(args.to).toBe("new@example.com");
    expect(args.from).toEqual({ name: "uploads.sh", email: "noreply@uploads.sh" });
    expect(args.subject).toBe("Welcome to uploads.sh");
    expect(args.html).toContain("uploads install");
    expect(args.html).toContain("acme");
    expect(args.html).toContain("https://github.com/apps/uploads-sh");
  });

  it("never throws when send fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendWelcomeEmail(
        { EMAIL: { send }, WEB_ORIGIN: "https://uploads.sh" },
        { to: "a@example.com", workspaceName: "x" },
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
