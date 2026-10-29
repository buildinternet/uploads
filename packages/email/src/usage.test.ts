import { describe, expect, it } from "vitest";
import { renderUsageAlertEmail } from "./usage";

const BILLING = "https://uploads.sh/account/workspaces/acme/billing";
const BUCKET = "https://uploads.sh/account/workspaces/acme/storage#bucket";

describe("renderUsageAlertEmail", () => {
  it("says storage is almost gone at 90%, with the real amounts", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 225_000_000, limit: 250_000_000 }],
      plan: "free",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toBe("Acme is almost out of storage");
    expect(email.html).toContain("running low on storage");
    expect(email.text).toContain(
      "Acme has used 225 MB of its 250 MB. Uploads keep working until it's full.",
    );
    expect(email.text).toContain(
      `To get more room, upgrade your plan (${BILLING}) or connect your own bucket (${BUCKET}) (it isn't metered).`,
    );
    expect(email.html).toContain(`href="${BILLING}" style="color:#b9b0cf;">upgrade your plan</a>`);
    expect(email.html).toContain(
      `href="${BUCKET}" style="color:#b9b0cf;">connect your own bucket</a>`,
    );
    expect(email.html).toContain("Get more storage →");
    expect(email.html).toContain(BILLING);
    expect(email.html).not.toContain("/account/workspaces/acme/settings");
    expect(email.html).not.toContain("225000000");
    expect(email.html).toContain("https://uploads.sh/account/profile");
  });

  it("uses a gentler subject when storage crosses 50%", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 50, used: 125_000_000, limit: 250_000_000 }],
      plan: "free",
    });
    expect(email.subject).toBe("Acme has used half its storage");
    expect(email.html).toContain("running low on storage");
    expect(email.text).toContain("Acme has used 125 MB of its 250 MB.");
  });

  it("says storage is full at 100%", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 100, used: 250_000_000, limit: 250_000_000 }],
      plan: "free",
    });
    expect(email.subject).toBe("Acme's storage is full");
    expect(email.html).toContain("Your storage is full");
    expect(email.text).toContain(
      "Acme has used all 250 MB, so new uploads are paused. Everything you've already uploaded is safe and still works.",
    );
    expect(email.text).toContain(
      `Upgrade your plan (${BILLING}) or connect your own bucket (${BUCKET}) to start uploading again.`,
    );
    expect(email.html).toContain("Get more storage →");
  });

  it("says the monthly upload limit is hit, and does not offer a bucket", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 100, used: 3000, limit: 3000 }],
      plan: "free",
    });
    expect(email.subject).toBe("Acme hit this month's upload limit");
    expect(email.html).toContain("hit this month");
    expect(email.text).toContain(
      "Acme has used all its uploads for this month. They reset at the start of next month, or you can upgrade now",
    );
    expect(email.text).toContain(BILLING);
    expect(email.text).not.toContain("bucket");
    expect(email.html).not.toContain("/account/workspaces/acme/storage");
    expect(email.html).toContain("Upgrade your plan →");
  });

  it("says uploads are close at 90%, and half at 50%", () => {
    const close = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 90, used: 2700, limit: 3000 }],
      plan: "free",
    });
    expect(close.subject).toBe("Acme is close to this month's upload limit");
    expect(close.text).toContain("Acme has used 2,700 of its 3,000 uploads this month.");
    expect(close.text).toContain("They reset at the start of next month");

    const half = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 50, used: 1500, limit: 3000 }],
      plan: "free",
    });
    expect(half.subject).toBe("Acme has used half its uploads this month");
    expect(half.html).toContain("close to this month");
  });

  it("states both caps when they cross in one sweep", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [
        { cap: "storage", threshold: 90, used: 9_000_000_000, limit: 10_000_000_000 },
        { cap: "uploads", threshold: 50, used: 1500, limit: 3000 },
      ],
      plan: "free",
    });
    expect(email.subject).toBe("Acme is almost out of storage");
    expect(email.text).toContain("Acme has used 9 GB of its 10 GB.");
    expect(email.text).toContain("Acme has used 1,500 of its 3,000 uploads this month.");
    expect(email.text).toContain("connect your own bucket");
    expect(email.html).not.toContain("9000000000");
  });

  it("does not offer an upgrade to a workspace already on pro", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "uploads", threshold: 90, used: 90_000, limit: 100_000 }],
      plan: "pro",
    });
    expect(email.text).not.toContain("upgrade");
    expect(email.text).not.toContain("bucket");
    expect(email.text).toContain(
      "Acme has used 90,000 of its 100,000 uploads this month. They reset at the start of next month.",
    );
    expect(email.html).toContain("View billing →");
  });

  it("still offers the bucket to a pro workspace hitting its storage cap", () => {
    const email = renderUsageAlertEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [{ cap: "storage", threshold: 90, used: 9_000_000_000, limit: 10_000_000_000 }],
      plan: "pro",
    });
    expect(email.subject).toBe("Acme is almost out of storage");
    expect(email.text).not.toContain("upgrade");
    expect(email.text).toContain(`connect your own bucket (${BUCKET}) (it isn't metered).`);
    expect(email.html).toContain("Get more storage →");
  });
});
