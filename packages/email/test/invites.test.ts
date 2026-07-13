import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  renderEmailCard,
  renderEnrollmentInvitationEmail,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
} from "../src/index";

describe("escapeHtml", () => {
  it("escapes angle brackets and quotes", () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`"><script>`)).toBe("&quot;&gt;&lt;script&gt;");
  });
});

describe("renderEmailCard", () => {
  it("builds a full HTML document with CTA", () => {
    const out = renderEmailCard({
      subject: "Test",
      preheader: "Preview line",
      title: "Hello",
      bodyHtml: "Body <strong>here</strong>",
      text: "Body here",
      cta: { url: "https://uploads.sh/x", label: "Go →" },
    });
    expect(out.subject).toBe("Test");
    expect(out.html).toContain("<!doctype html>");
    expect(out.html).toContain("Hello");
    expect(out.html).toContain("https://uploads.sh/x");
    expect(out.html).toContain("Go →");
    expect(out.html).toContain("/terms");
    expect(out.html).toContain("/privacy");
  });

  it("omits the CTA block when not provided", () => {
    const out = renderEmailCard({
      subject: "Notify",
      preheader: "p",
      title: "Joined",
      bodyHtml: "ok",
      text: "ok",
    });
    expect(out.html).not.toContain("background-color:#b794ff");
  });
});

describe("renderOrgInvitationEmail", () => {
  it("escapes org name and inviter in HTML", () => {
    const out = renderOrgInvitationEmail({
      url: "https://uploads.sh/accept-invitation/abc",
      organizationName: `<img src=x onerror=alert(1)>`,
      inviterEmail: `"><script>alert(2)</script>`,
    });
    expect(out.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(out.html).not.toContain("<script>alert(2)</script>");
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out.subject).toContain("<img");
    expect(out.html).toContain("Accept invitation");
    expect(out.text).toContain("https://uploads.sh/accept-invitation/abc");
  });
});

describe("renderEnrollmentInvitationEmail", () => {
  it("special-cases the default workspace subject and body", () => {
    const out = renderEnrollmentInvitationEmail({
      workspaceName: "default",
      link: "https://uploads.sh/invite?id=upi_x#code=secret",
      expiresAt: "2030-01-15T12:00:00.000Z",
    });
    expect(out.subject).toBe("You've been given access to uploads.sh");
    expect(out.text).toContain("#code=secret");
    expect(out.html).toContain("You've been given access");
    expect(out.html).toContain("laptop");
  });

  it("names a non-default workspace in the subject", () => {
    const out = renderEnrollmentInvitationEmail({
      workspaceName: "buildinternet",
      link: "https://uploads.sh/invite?id=upi_y#code=z",
      expiresAt: "2030-01-15T12:00:00.000Z",
    });
    expect(out.subject).toBe("You're invited to buildinternet on uploads.sh");
    expect(out.html).toContain("buildinternet");
  });

  it("escapes a hostile workspace name in HTML", () => {
    const out = renderEnrollmentInvitationEmail({
      workspaceName: `<script>x</script>`,
      link: "https://uploads.sh/invite?id=upi_z#code=z",
      expiresAt: "2030-01-15T12:00:00.000Z",
    });
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("renderMemberJoinedEmail", () => {
  it("names the joiner and workspace", () => {
    const out = renderMemberJoinedEmail({
      organizationName: "buildinternet",
      memberEmail: "new@example.com",
    });
    expect(out.subject).toBe("new@example.com joined buildinternet on uploads.sh");
    expect(out.html).toContain("Someone joined");
    expect(out.html).toContain("new@example.com");
    expect(out.html).toContain("buildinternet");
    expect(out.text).toContain("accepted your invitation");
  });
});
