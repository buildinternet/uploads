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

  it("omits the magic-link URL when EMAIL binding is absent in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendAuthEmail(
      { ENVIRONMENT: "production" },
      {
        to: "a@example.com",
        template: "magic-link",
        context: { url: "https://auth.uploads.sh/secret-link" },
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("https://auth.uploads.sh/secret-link");
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

  it("routes invitation + member-joined through the shared templates", async () => {
    const send = vi.fn().mockResolvedValue({});
    const EMAIL: EmailBinding = { send };

    await sendAuthEmail(
      { EMAIL, ENVIRONMENT: "production" },
      {
        to: "a@example.com",
        template: "invitation",
        context: {
          url: "https://uploads.sh/accept-invitation/abc",
          organizationName: `<img src=x onerror=alert(1)>`,
          inviterEmail: `"><script>alert(2)</script>`,
        },
      },
    );
    await sendAuthEmail(
      { EMAIL, ENVIRONMENT: "production" },
      {
        to: "admin@example.com",
        template: "member-joined",
        context: { organizationName: "buildinternet", memberEmail: "new@example.com" },
      },
    );

    const invite = send.mock.calls[0]?.[0];
    expect(invite.html).toContain("<!doctype html>");
    expect(invite.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(invite.html).not.toContain("<script>alert(2)</script>");

    const joined = send.mock.calls[1]?.[0];
    expect(joined.to).toBe("admin@example.com");
    expect(joined.subject).toBe("new@example.com joined buildinternet on uploads.sh");
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
