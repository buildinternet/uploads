import { describe, expect, it } from "vitest";
import { renderAbuseReportEmail } from "../src/abuse";

describe("renderAbuseReportEmail", () => {
  it("includes reason, page URL, and operator-facing subject", () => {
    const mail = renderAbuseReportEmail({
      id: "ab_test",
      reason: "copyright",
      message: "This is my photo",
      contact: "owner@example.com",
      pageUrl: "https://uploads.sh/f/acme/shot.png",
      workspace: "acme",
      objectKey: "shot.png",
      surface: "web",
      createdAt: "2026-07-22T00:00:00.000Z",
    });

    expect(mail.subject).toMatch(/^\[abuse\] copyright:/);
    expect(mail.text).toContain("https://uploads.sh/f/acme/shot.png");
    expect(mail.text).toContain("owner@example.com");
    expect(mail.html).toContain("ab_test");
    expect(mail.html).toContain("Open reported page");
    expect(mail.html).toContain("This is my photo");
  });
});
