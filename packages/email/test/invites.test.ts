import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  renderEmailCard,
  renderEnrollmentInvitationEmail,
  renderMagicLinkEmail,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
  renderWelcomeEmail,
} from "../src/index";

function parseJsonLd(html: string): Record<string, unknown> | null {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) return null;
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("escapeHtml", () => {
  it("escapes angle brackets and quotes", () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`"><script>`)).toBe("&quot;&gt;&lt;script&gt;");
  });
});

describe("renderEmailCard", () => {
  it("builds a full HTML document with CTA and inferred ViewAction", () => {
    const out = renderEmailCard({
      subject: "Test",
      preheader: "Preview line",
      eyebrow: "Invitation",
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

    const ld = parseJsonLd(out.html);
    expect(ld?.["@type"]).toBe("EmailMessage");
    expect(ld?.potentialAction).toEqual({
      "@type": "ViewAction",
      name: "Go",
      url: "https://uploads.sh/x",
    });
    expect(ld?.description).toBe("Preview line");
    expect(ld?.publisher).toEqual({
      "@type": "Organization",
      name: "uploads.sh",
      url: "https://uploads.sh",
    });
  });

  it("embeds an explicit one-click ConfirmAction", () => {
    const out = renderEmailCard({
      subject: "Approve",
      preheader: "Needs your approval",
      eyebrow: "Approval",
      title: "Approve request",
      bodyHtml: "Please approve.",
      text: "Please approve.",
      cta: { url: "https://uploads.sh/approve/1", label: "Review →" },
      gmailAction: {
        type: "ConfirmAction",
        name: "Approve",
        handlerUrl: "https://api.uploads.sh/v1/actions/approve?id=1",
        description: "Approve this request",
      },
    });
    expect(parseJsonLd(out.html)?.potentialAction).toEqual({
      "@type": "ConfirmAction",
      name: "Approve",
      handler: {
        "@type": "HttpActionHandler",
        url: "https://api.uploads.sh/v1/actions/approve?id=1",
      },
    });
  });

  it("suppresses Gmail markup when gmailAction is false", () => {
    const out = renderEmailCard({
      subject: "Test",
      preheader: "p",
      eyebrow: "x",
      title: "t",
      bodyHtml: "b",
      text: "b",
      cta: { url: "https://uploads.sh/x", label: "Go →" },
      gmailAction: false,
    });
    expect(out.html).not.toContain("application/ld+json");
  });

  it("escapes </ in JSON-LD so script tags cannot break out", () => {
    const out = renderEmailCard({
      subject: "Test",
      preheader: "p",
      eyebrow: "x",
      title: "t",
      bodyHtml: "b",
      text: "b",
      cta: { url: "https://uploads.sh/</script>alert(1)", label: "Go" },
    });
    expect(out.html).toContain("\\u003c/script>");
    expect(out.html).not.toMatch(/ld\+json">[\s\S]*<\/script>alert/);
  });

  it("omits the CTA block and Gmail markup when not provided", () => {
    const out = renderEmailCard({
      subject: "Notify",
      preheader: "p",
      eyebrow: "Membership",
      title: "Joined",
      bodyHtml: "ok",
      text: "ok",
    });
    expect(out.html).not.toContain("background-color:#c27eff");
    expect(out.html).not.toContain("Or paste this link");
    expect(out.html).not.toContain("application/ld+json");
  });
});

describe("renderMagicLinkEmail", () => {
  it("embeds a Sign in ViewAction for the magic-link URL", () => {
    const url = "https://uploads.sh/api/auth/magic-link/verify?token=abc";
    const ld = parseJsonLd(renderMagicLinkEmail({ url }).html);
    expect(ld?.potentialAction).toEqual({
      "@type": "ViewAction",
      name: "Sign in",
      url,
    });
  });
});

describe("renderOrgInvitationEmail", () => {
  it("escapes org name and inviter, and embeds Accept invitation ViewAction", () => {
    const url = "https://uploads.sh/accept-invitation/abc";
    const out = renderOrgInvitationEmail({
      url,
      organizationName: `<img src=x onerror=alert(1)>`,
      inviterEmail: `"><script>alert(2)</script>`,
    });
    expect(out.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(out.html).not.toContain("<script>alert(2)</script>");
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out.subject).toContain("<img");
    expect(out.html).toContain("Accept invitation");
    expect(out.text).toContain(url);
    expect(parseJsonLd(out.html)?.potentialAction).toEqual({
      "@type": "ViewAction",
      name: "Accept invitation",
      url,
    });
  });
});

describe("renderEnrollmentInvitationEmail", () => {
  it("special-cases the default workspace subject and body", () => {
    const link = "https://uploads.sh/invite?id=upi_x#code=secret";
    const out = renderEnrollmentInvitationEmail({
      workspaceName: "default",
      link,
      expiresAt: "2030-01-15T12:00:00.000Z",
    });
    expect(out.subject).toBe("You've been given access to uploads.sh");
    expect(out.text).toContain("#code=secret");
    expect(out.html).toContain("You've been given access");
    expect(out.html).toContain("laptop");
    expect(parseJsonLd(out.html)?.potentialAction).toEqual({
      "@type": "ViewAction",
      name: "Accept invitation",
      url: link,
    });
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
  it("names the joiner and workspace without Gmail action markup", () => {
    const out = renderMemberJoinedEmail({
      organizationName: "buildinternet",
      memberEmail: "new@example.com",
    });
    expect(out.subject).toBe("new@example.com joined buildinternet on uploads.sh");
    expect(out.html).toContain("Someone joined");
    expect(out.html).toContain("new@example.com");
    expect(out.html).toContain("buildinternet");
    expect(out.text).toContain("accepted your invitation");
    expect(out.html).not.toContain("application/ld+json");
  });
});

describe("renderWelcomeEmail", () => {
  it("names the workspace, links next steps, and embeds a docs ViewAction", () => {
    const out = renderWelcomeEmail({
      workspaceName: "acme",
      webOrigin: "https://uploads.sh",
    });
    expect(out.subject).toBe("Welcome to uploads.sh");
    expect(out.html).toContain("You&#39;re in");
    expect(out.html).toContain("acme");
    expect(out.html).toContain("uploads install");
    expect(out.html).toContain("https://github.com/apps/uploads-sh");
    expect(out.html).toContain("https://github.com/buildinternet/uploads");
    expect(out.html).toContain("https://uploads.sh/docs");
    expect(out.text).toContain("uploads install");
    expect(out.text).toContain("github.com/buildinternet/uploads");
    expect(parseJsonLd(out.html)?.potentialAction).toEqual({
      "@type": "ViewAction",
      name: "Open the docs",
      url: "https://uploads.sh/docs",
    });
  });

  it("escapes hostile workspace names", () => {
    const out = renderWelcomeEmail({
      workspaceName: `<script>x</script>`,
      webOrigin: "https://uploads.sh",
    });
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("omits the workspace clause when name is empty", () => {
    const out = renderWelcomeEmail({ webOrigin: "https://uploads.sh" });
    expect(out.html).toContain("Your uploads.sh account is ready");
    expect(out.text).toContain("Your uploads.sh account is ready");
  });
});
