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
    ],
    storageNote: {
      text: "Acme is using 86% of its storage. Upgrade or connect a bucket when you're ready",
      href: "/account/workspaces/acme/billing",
    },
  },
};

describe("renderWeeklyDigestEmail", () => {
  it("leads a member digest with one highlight, the top pull request, and a stat line", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–11",
      user,
      pulses: [],
      unsubscribeDigestUrl: "https://auth.uploads.sh/digest/unsubscribe?token=member",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Your week in Acme (Oct 5–11)");
    expect(email.html).toContain("Your week in Acme");
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
    expect(email.text).toContain("Unsubscribe from Acme's weekly summary");
  });

  it("renders an admin pulse as three numbers, plain lines, and a storage footnote", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–11",
      pulses: [pulse],
      unsubscribeWorkspaceUrl: "https://auth.uploads.sh/digest/unsubscribe?token=admin",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Acme admin pulse (Oct 5–11)");
    expect(email.html).toContain(">Acme<");
    expect(email.html).toContain("37");
    expect(email.html).toContain("+12");
    expect(email.html).toContain("+2 new");
    expect(email.html).toContain("1.2 GB");
    expect(email.html).toContain("+80 MB");
    expect(email.html).toContain("<ul");
    expect(email.html).toContain("acme/web got busy");
    expect(email.html).toContain("Ada&#39;s first upload");
    expect(email.html).not.toContain("https://github.com/acme/web");
    const list = email.html.slice(email.html.indexOf("<ul"), email.html.indexOf("</ul>"));
    expect(list).not.toContain("<a");
    expect(list).toContain("got busy");
    expect(email.html).toContain("Acme is using 86% of its storage.");
    expect(email.html).toContain(">Upgrade</a>");
    expect(email.html).toContain(">connect a bucket</a>");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/billing");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/storage#bucket");
    expect(email.text).toContain(
      "Acme is using 86% of its storage. Upgrade: https://uploads.sh/account/workspaces/acme/billing or connect a bucket: https://uploads.sh/account/workspaces/acme/storage#bucket when you're ready.",
    );
    expect(email.html).not.toMatch(/<a[^>]*>Acme is using 86%/);
    expect(email.html).toContain("See your full week");
    expect(email.text).toContain("- acme/web got busy — 8 files, up from 1");
    expect(email.text).toContain("- Ada's first upload");
    expect(email.text).not.toContain("https://github.com/acme/web");
    expect(email.text).toContain("Unsubscribe from Acme's admin pulse");
  });

  it("omits callouts when the pulse has nothing notable", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–11",
      pulses: [
        {
          ...pulse,
          pulse: {
            ...pulse.pulse,
            uploadsDelta: 0,
            activeMembersNew: 0,
            storageDeltaBytes: 0,
            notes: [],
            storageNote: undefined,
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
      weekLabel: "Oct 5–11",
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

  it("names one workspace in the subject and ignores a second pulse", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–11",
      user: { ...user, workspaceName: undefined, workspaceSlug: undefined },
      pulses: [pulse, { ...pulse, slug: "beta", name: "Beta" }],
    });
    expect(email.subject).toBe("Your week in Acme (Oct 5–11)");
    expect(email.html).not.toContain("Beta");
    expect(email.html).not.toContain("Your week on uploads.sh");
    expect(email.subject).not.toContain("Your week on uploads.sh");
  });

  it("uses the member subject when the same workspace also includes an admin pulse", () => {
    const email = renderWeeklyDigestEmail({
      weekLabel: "Oct 5–11",
      user,
      pulses: [pulse],
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Your week in Acme (Oct 5–11)");
    expect(email.html).toContain("Admin pulse");
    expect(email.html).toContain("37 uploads across 4 repos");
    expect(email.html).toContain("acme/web got busy");
  });
});
