import { describe, expect, it, vi } from "vitest";
import { sendAuthEmail, type EmailBinding } from "./email";

describe("sendAuthEmail", () => {
  it("logs the link instead of sending when EMAIL binding is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendAuthEmail(
      { ENVIRONMENT: "development" },
      {
        to: "a@example.com",
        template: "magic-link",
        context: { url: "https://auth.uploads.sh/x" },
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("https://auth.uploads.sh/x");
    warn.mockRestore();
  });

  it("sends from noreply@uploads.sh when EMAIL binding is present", async () => {
    const send = vi.fn().mockResolvedValue({});
    const EMAIL: EmailBinding = { send };
    await sendAuthEmail(
      { EMAIL, ENVIRONMENT: "production" },
      {
        to: "a@example.com",
        template: "magic-link",
        context: { url: "https://auth.uploads.sh/x" },
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]?.[0];
    expect(args.to).toBe("a@example.com");
    expect(args.from).toEqual({ name: "uploads.sh", email: "noreply@uploads.sh" });
    expect(args.subject).toContain("Sign in");
    expect(args.text).toContain("https://auth.uploads.sh/x");
  });

  it("never throws when the send fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendAuthEmail(
        { EMAIL: { send }, ENVIRONMENT: "production" },
        { to: "a@example.com", template: "magic-link", context: { url: "https://x" } },
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
