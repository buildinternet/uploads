import { describe, expect, it } from "vitest";
import { renderWeeklyDigestEmail } from "./digest";

const section = {
  slug: "acme",
  name: "Acme",
  blurb:
    "Acme uploaded 12 files (4.2 MB added) this week. Most of the week's files in Acme landed in acme/web.",
  uploads: 12,
  bytesAdded: 4_200_000,
  repos: [{ name: "acme/web", count: 8 }],
  screenshots: [
    {
      url: "https://storage.uploads.sh/acme/settings.png",
      embedUrl: "https://embed.uploads.sh/acme/settings.png",
      label: "/settings",
    },
  ],
  pulls: [
    {
      label: "acme/web#12",
      href: "https://github.com/acme/web/pull/12",
      detail: "Digest settings",
    },
  ],
  issues: [{ label: "acme/web#4", href: "https://github.com/acme/web/issues/4" }],
  pages: [{ path: "/settings", count: 3 }],
  galleries: ["Launch"],
  galleryCount: 1,
  feeds: 1,
  admin: {
    storageBytes: 1_200_000_000,
    objects: 40,
    uploadsThisMonth: 18,
    newMembers: 2,
    activePeople: 5,
  },
};

describe("renderWeeklyDigestEmail", () => {
  it("renders the week's counts, links, and a thumbnail", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      sections: [section],
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
      unsubscribeWorkspaceUrl: "https://auth.uploads.sh/digest/unsubscribe?token=admin",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Your week in Acme");
    expect(email.html).toContain("4.2 MB");
    expect(email.html).toContain("12 files uploaded");
    expect(email.html).toContain("https://embed.uploads.sh/acme/settings.png");
    expect(email.html).toContain('alt="/settings"');
    expect(email.html).toContain("https://github.com/acme/web/pull/12");
    expect(email.html).toContain("https://github.com/acme/web/issues/4");
    expect(email.html).toContain("/settings");
    expect(email.html).toContain("Launch");
    expect(email.html).toContain("1.2 GB");
    expect(email.html).toContain("2 people joined");
    expect(email.html).toContain("token=member");
    expect(email.html).toContain("token=admin");
    expect(email.text).toContain("acme/web (8)");
    expect(email.text).toContain("Unsubscribe from this weekly summary");
    expect(email.text).toContain("Unsubscribe from workspace summaries");
  });

  it("uses a general subject when more than one workspace is included", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      sections: [section, { ...section, slug: "beta", name: "Beta", admin: undefined }],
      omittedWorkspaces: 2,
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
    });
    expect(email.subject).toBe("Your week on uploads.sh");
    expect(email.text).toContain("2 more workspaces");
    expect(email.html).not.toContain("token=admin");
  });

  it("drops a non-https thumbnail instead of embedding it", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      sections: [
        {
          ...section,
          screenshots: [{ url: "javascript:alert(1)", label: "bad" }],
          admin: undefined,
        },
      ],
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
    });
    expect(email.html).not.toContain("javascript:");
    expect(email.html).not.toContain('alt="bad"');
    expect(email.html).not.toContain("Screenshots");
  });
});
