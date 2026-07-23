import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatMarketedBytes,
  orderOrgsOldestFirst,
  renderInvitesHtml,
  renderMembersHtml,
  renderUsageHtml,
  safeSameOriginPath,
} from "./workspace-ui";

describe("formatBytes / formatMarketedBytes (decimal SI)", () => {
  it("renders the catalog's round decimal caps exactly as marketed", () => {
    expect(formatMarketedBytes(250_000_000)).toBe("250 MB");
    expect(formatMarketedBytes(25_000_000)).toBe("25 MB");
    expect(formatMarketedBytes(8_000_000)).toBe("8 MB");
    expect(formatMarketedBytes(10_000_000_000)).toBe("10 GB");
    expect(formatMarketedBytes(100_000_000)).toBe("100 MB");
    // formatBytes is the same SI path (no more binary 238 MB for free).
    expect(formatBytes(250_000_000)).toBe("250 MB");
  });

  it("handles sub-KB and fractional values", () => {
    expect(formatMarketedBytes(500)).toBe("500 B");
    expect(formatMarketedBytes(1_500_000)).toBe("1.5 MB");
  });
});

describe("renderMembersHtml", () => {
  it("leads with the display name and shows email as the sub-line", () => {
    const html = renderMembersHtml([{ email: "a@b.com", name: "Ada", role: "owner" }]);
    expect(html).toContain(">Ada<");
    expect(html).toContain(">a@b.com<");
    expect(html).toContain(">owner<");
  });

  it("leads with the email when there is no display name, without a sub-line", () => {
    const html = renderMembersHtml([{ email: "c@d.com", name: "", role: "member" }]);
    expect(html).toContain('member-row__name">c@d.com<');
    expect(html).not.toContain("member-row__email");
  });

  it("escapes interpolated fields and renders [] as empty", () => {
    const html = renderMembersHtml([
      { email: "<img src=x>", name: "<b>x</b>", role: '"><script>alert(1)</script>' },
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(renderMembersHtml([])).toBe("");
  });
});

describe("renderMembersHtml controls", () => {
  const rows = [
    { id: "m_owner", email: "owner@x.com", name: "", role: "owner" },
    { id: "m_admin", email: "admin@x.com", name: "", role: "admin" },
    { id: "m_member", email: "member@x.com", name: "", role: "member" },
    { id: "m_me", email: "me@x.com", name: "", role: "admin" },
  ];
  it("renders no controls without canManage", () => {
    const html = renderMembersHtml(rows);
    expect(html).not.toContain("data-member-id");
  });
  it("renders owner controls for member and admin rows (not owner/self)", () => {
    const html = renderMembersHtml(rows, {
      canManage: true,
      viewerRole: "owner",
      selfEmail: "me@x.com",
    });
    expect(html).toContain('data-member-id="m_admin"');
    expect(html).toContain('data-member-id="m_member"');
    expect(html).not.toContain('data-member-id="m_owner"');
    expect(html).not.toContain('data-member-id="m_me"');
  });
  it("renders admin controls for member rows only (not other admins)", () => {
    const html = renderMembersHtml(rows, {
      canManage: true,
      viewerRole: "admin",
      selfEmail: "me@x.com",
    });
    expect(html).toContain('data-member-id="m_member"');
    expect(html).not.toContain('data-member-id="m_admin"');
    expect(html).not.toContain('data-member-id="m_owner"');
    expect(html).not.toContain('data-member-id="m_me"');
  });
});

describe("renderInvitesHtml", () => {
  it("renders a people-list row with pending status and revoke", () => {
    const html = renderInvitesHtml([{ id: "i1", email: "a@x.com", status: "pending" }]);
    expect(html).toContain('data-invite-id="i1"');
    expect(html).toContain("a@x.com");
    expect(html).toContain("member-row--pending");
    expect(html).toContain("pending");
    expect(html).toContain("invite-row__revoke");
  });
  it("returns empty string for no invites", () => {
    expect(renderInvitesHtml([])).toBe("");
  });
});

describe("safeSameOriginPath", () => {
  it("accepts an absolute in-app path with query and hash", () => {
    expect(safeSameOriginPath("/oauth/consent?client_id=c1&sig=x#top")).toBe(
      "/oauth/consent?client_id=c1&sig=x#top",
    );
  });

  it("rejects everything that could navigate off-origin", () => {
    expect(safeSameOriginPath(undefined)).toBeNull();
    expect(safeSameOriginPath("")).toBeNull();
    expect(safeSameOriginPath("relative/path")).toBeNull();
    expect(safeSameOriginPath("https://evil.example/x")).toBeNull();
    // Protocol-relative and the backslash variant browsers normalize to it.
    expect(safeSameOriginPath("//evil.example")).toBeNull();
    expect(safeSameOriginPath("/\\evil.example")).toBeNull();
    // Defense in depth: a raw embedded scheme is rejected even inside the
    // query — legitimate producers percent-encode (the consent page does).
    expect(safeSameOriginPath("/ok?u=https://evil.example")).toBeNull();
  });
});

describe("renderUsageHtml", () => {
  it("falls back to plain text when no quota caps are set", () => {
    const html = renderUsageHtml({
      bytes: 8_000_000,
      objects: 64,
      uploadsInPeriod: 1,
    });
    expect(html).toContain("usage-text");
    expect(html).toContain("8 MB");
    expect(html).toContain("64 objects");
    expect(html).toContain("1 uploads this month");
    expect(html).not.toContain("ul-progress");
  });

  it("renders labeled progress meters when storage and upload caps exist", () => {
    const html = renderUsageHtml({
      bytes: 500,
      objects: 3,
      uploadsInPeriod: 2,
      maxStorageBytes: 1000,
      maxUploadsPerPeriod: 10,
    });
    expect(html).toContain('class="ul-progress"');
    expect(html).toContain("Storage");
    expect(html).toContain("Uploads this month");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("3 objects");
    expect(html).not.toContain("usage-text");
  });
});

describe("orderOrgsOldestFirst", () => {
  it("orders by createdAt ascending (oldest first)", () => {
    const orgs = [
      { slug: "newest", createdAt: "2026-03-01T00:00:00Z" },
      { slug: "oldest", createdAt: "2024-01-01T00:00:00Z" },
      { slug: "middle", createdAt: "2025-02-01T00:00:00Z" },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["oldest", "middle", "newest"]);
  });

  it("accepts Date instances alongside strings", () => {
    const orgs = [
      { slug: "b", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "a", createdAt: new Date("2020-01-01T00:00:00Z") },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["a", "b"]);
  });

  it("keeps given relative order for entries without createdAt (stable)", () => {
    const orgs = [{ slug: "first" }, { slug: "second" }, { slug: "third" }];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["first", "second", "third"]);
  });

  it("sorts dated entries before undated entries regardless of input order", () => {
    const orgs = [{ slug: "undated" }, { slug: "dated", createdAt: "2026-01-01T00:00:00Z" }];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["dated", "undated"]);
  });

  it("tolerates an unparseable createdAt string as if undated", () => {
    const orgs = [
      { slug: "bad", createdAt: "not-a-date" },
      { slug: "good", createdAt: "2026-01-01T00:00:00Z" },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["good", "bad"]);
  });

  it("does not mutate the input array", () => {
    const orgs = [
      { slug: "b", createdAt: "2026-01-01T00:00:00Z" },
      { slug: "a", createdAt: "2020-01-01T00:00:00Z" },
    ];
    const copy = [...orgs];
    orderOrgsOldestFirst(orgs);
    expect(orgs).toEqual(copy);
  });
});
