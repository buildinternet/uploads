import { describe, expect, it } from "vitest";
import { renderUsageAlertEmail } from "./usage";

describe("renderUsageAlertEmail", () => {
  it("renders a single storage crossing with formatted bytes and CTA", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 225_000_000, limit: 250_000_000 }],
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

  it("says 'reached' (not a percentage) when a cap hits 100%", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 100, used: 3000, limit: 3000 }],
    });
    expect(email.subject.toLowerCase()).toContain("reached");
    expect(email.subject).not.toContain("%");
    expect(email.html).toContain("limit reached");
    // Upload counts are grouped, not byte-formatted.
    expect(email.text).toContain("3,000 of 3,000 uploads this month");
  });

  it("covers both caps in one email when they cross together", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [
        { cap: "storage", threshold: 90, used: 9_000_000_000, limit: 10_000_000_000 },
        { cap: "uploads", threshold: 50, used: 1500, limit: 3000 },
      ],
    });
    expect(email.subject.toLowerCase()).toContain("approaching");
    expect(email.html).toContain("Storage");
    expect(email.html).toContain("Monthly uploads");
    expect(email.html).toContain("9 GB");
    expect(email.html).toContain("1,500 of 3,000 uploads this month");
  });
});
