import { describe, expect, it } from "vitest";
import {
  renderWeeklyDigestEmail,
  type WeeklyDigestPulseBlock,
  type WeeklyDigestUser,
} from "./digest";

const user: WeeklyDigestUser = {
  workspaceName: "Acme",
  workspaceSlug: "acme",
  highlight: {
    url: "https://storage.uploads.sh/acme/settings.png",
    embedUrl: "https://embed.uploads.sh/acme/settings.png",
    caption: "/settings",
    href: "https://github.com/acme/web/pull/12",
    hrefLabel: "acme/web#12",
  },
  topPull: {
    title: "Weekly digest settings",
    repo: "acme/web",
    number: 12,
    href: "https://github.com/acme/web/pull/12",
    state: "open",
    thumbnailUrl: "https://storage.uploads.sh/acme/pull.png",
    thumbnailEmbedUrl: "https://embed.uploads.sh/acme/pull.png",
  },
  uploads: 37,
  repos: 4,
};

const pulse: WeeklyDigestPulseBlock = {
  slug: "acme",
  name: "Acme",
  pulse: {
    uploads: 37,
    uploadsDelta: 12,
    activeMembers: 8,
    activeMembersNew: 2,
    storageBytes: 1_200_000_000,
    storageDeltaBytes: 80_000_000,
    notes: [
      { text: "acme/web got busy — 8 files, up from 1", href: "https://github.com/acme/web" },
      { text: "Ada's first upload", href: "/account/workspaces/acme/files" },
      { text: "Storage is at 86% of the plan", href: "/account/workspaces/acme/billing" },
    ],
  },
};

describe("renderWeeklyDigestEmail", () => {
  it("leads a member digest with one highlight, the top pull request, and a stat line", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      user,
      pulses: [],
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Your week in Acme");
    expect(email.html).toContain("https://embed.uploads.sh/acme/settings.png");
    expect(email.html).toContain('alt="/settings"');
    expect(email.html).toContain("https://github.com/acme/web/pull/12");
    expect(email.html).toContain("Weekly digest settings");
    expect(email.html).toContain("Open");
    expect(email.html).toContain("37 uploads across 4 repos");
    expect(email.html).toContain("See your full week");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/files");
    expect(email.html).not.toContain("Issues");
    expect(email.html).not.toContain("Pages");
    expect(email.html).not.toContain("Active repos");
    expect(email.text).toContain("See your full week:");
    expect(email.text).toContain("Unsubscribe from this weekly summary");
  });

  it("renders an admin pulse as three numbers and linked callouts", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      pulses: [pulse],
      unsubscribeWorkspaceUrl: "https://auth.uploads.sh/digest/unsubscribe?token=admin",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Your week in Acme");
    expect(email.html).toContain("Admin pulse");
    expect(email.html).toContain("37");
    expect(email.html).toContain("+12");
    expect(email.html).toContain("+2 new");
    expect(email.html).toContain("1.2 GB");
    expect(email.html).toContain("+80 MB");
    expect(email.html).toContain("https://github.com/acme/web");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/files");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/billing");
    expect(email.html).not.toContain("<ul");
    expect(email.text).toContain("Unsubscribe from workspace summaries");
  });

  it("omits callouts when the pulse has nothing notable", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      pulses: [
        {
          ...pulse,
          pulse: {
            ...pulse.pulse,
            uploadsDelta: 0,
            activeMembersNew: 0,
            storageDeltaBytes: 0,
            notes: [],
          },
        },
      ],
      webOrigin: "https://uploads.sh",
    });
    expect(email.html).toContain("no change");
    expect(email.html).not.toContain("got busy");
    expect(email.html).not.toContain("first upload");
  });

  it("drops a non-https thumbnail instead of embedding it", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      user: {
        ...user,
        highlight: { url: "javascript:alert(1)", caption: "bad" },
      },
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
    });
    expect(email.html).not.toContain("javascript:");
    expect(email.html).not.toContain('alt="bad"');
    expect(email.html).toContain("37 uploads across 4 repos");
  });

  it("uses a general subject when the week spans more than one workspace", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–12",
      user: { ...user, workspaceName: undefined, workspaceSlug: undefined },
      pulses: [pulse, { ...pulse, slug: "beta", name: "Beta" }],
      omittedWorkspaces: 2,
    });
    expect(email.subject).toBe("Your week on uploads.sh");
    expect(email.html).toContain("2 more workspaces");
    expect(email.html).toContain("https://uploads.sh/account/workspaces");
  });
});
