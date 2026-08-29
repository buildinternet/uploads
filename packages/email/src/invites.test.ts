import { describe, expect, it } from "vitest";
import { renderMemberJoinAdminNoticeEmail } from "./invites";

describe("renderMemberJoinAdminNoticeEmail", () => {
  it("renders subject, body, manage CTA, and settings footnote", () => {
    const email = renderMemberJoinAdminNoticeEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      memberEmail: "new@example.com",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toContain("Acme");
    expect(email.subject.toLowerCase()).toContain("joined");
    expect(email.html).toContain("new@example.com");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/settings");
    expect(email.html).toContain("https://uploads.sh/account/profile");
    expect(email.text).toContain("new@example.com");
  });
});
