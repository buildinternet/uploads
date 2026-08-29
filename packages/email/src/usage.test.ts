import { describe, expect, it } from "vitest";
import { renderUsageAlertEmail } from "./usage";

describe("renderUsageAlertEmail", () => {
  it("renders a single storage crossing with formatted bytes and CTA", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 225_000_000, limit: 250_000_000 }],
      plan: "free",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toContain("Acme");
    expect(email.subject).toContain("90%");
    expect(email.subject.toLowerCase()).toContain("storage");
    // Decimal byte formatting, not raw bytes.
    expect(email.html).toContain("225 MB");
    expect(email.html).toContain("250 MB");
    expect(email.html).not.toContain("225000000");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/settings");
    expect(email.html).toContain("https://uploads.sh/account/profile");
    expect(email.text).toContain("225 MB of 250 MB");
  });

  it("offers both remedies for a storage crossing on an upgradeable plan", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 225_000_000, limit: 250_000_000 }],
      plan: "free",
    });
    expect(email.text).toContain("upgrade to a paid plan");
    expect(email.text).toContain("connect your own storage bucket");
    expect(email.text).toContain("To raise your storage limit");
    // Remedies are clickable in the HTML.
    expect(email.html).toContain(">upgrade to a paid plan</a>");
    expect(email.html).toContain(">connect your own storage bucket</a>");
  });

  it("says 'reached' (not a percentage) when a cap hits 100%", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 100, used: 3000, limit: 3000 }],
      plan: "free",
    });
    expect(email.subject.toLowerCase()).toContain("reached");
    expect(email.subject).not.toContain("%");
    expect(email.html).toContain("limit reached");
    // Upload counts are grouped, not byte-formatted.
    expect(email.text).toContain("3,000 of 3,000 uploads this month");
    // An external bucket does not lift the upload-count cap, so it isn't offered.
    expect(email.text).toContain("upgrade to a paid plan");
    expect(email.text).not.toContain("storage bucket");
  });

  it("covers both caps in one email when they cross together", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [
        { cap: "storage", threshold: 90, used: 9_000_000_000, limit: 10_000_000_000 },
        { cap: "uploads", threshold: 50, used: 1500, limit: 3000 },
      ],
      plan: "free",
    });
    expect(email.subject.toLowerCase()).toContain("approaching");
    expect(email.html).toContain("Storage");
    expect(email.html).toContain("Monthly uploads");
    expect(email.html).toContain("9 GB");
    expect(email.html).toContain("1,500 of 3,000 uploads this month");
    expect(email.text).toContain("To raise these limits");
  });

  it("does not offer an upgrade to a workspace already on pro", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 90, used: 90_000, limit: 100_000 }],
      plan: "pro",
    });
    // No upgrade path and an external bucket doesn't change the upload cap →
    // the honest next step is the monthly reset.
    expect(email.text).not.toContain("upgrade to a paid plan");
    expect(email.text).not.toContain("storage bucket");
    expect(email.text).toContain("resets at the start of next month");
  });

  it("still offers the bucket to a pro workspace hitting its storage cap", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 9_000_000_000, limit: 10_000_000_000 }],
      plan: "pro",
    });
    expect(email.text).not.toContain("upgrade to a paid plan");
    expect(email.text).toContain("connect your own storage bucket");
  });
});
