import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatBytes,
  formatGalleryDate,
  formatMarketedBytes,
  orderOrgsOldestFirst,
  renderDetailListPlaceholderHtml,
  renderEmptyStateHtml,
  renderFilesPlaceholderHtml,
  renderGalleriesEmptyHtml,
  renderGalleriesGridHtml,
  renderGalleriesGridPlaceholderHtml,
  renderGalleriesHtml,
  renderGalleriesPlaceholderHtml,
  renderGalleriesTableHtml,
  renderGalleriesViewToggleHtml,
  renderInviteLinksHtml,
  renderInvitesHtml,
  renderMembersHtml,
  renderPeopleTableHtml,
  renderMembersPlaceholderHtml,
  renderUsageHtml,
  renderUsagePlaceholderHtml,
  renderWorkspacesPlaceholderHtml,
  safeSameOriginPath,
  skeletonBarHtml,
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
  it("renders name, email, and role as table cells", () => {
    const html = renderMembersHtml([{ email: "a@b.com", name: "Ada", role: "owner" }]);
    expect(html).toContain("<tr");
    expect(html).toContain(">Ada<");
    expect(html).toContain(">a@b.com<");
    expect(html).toContain(">owner<");
  });

  it("renders an em-dash name cell when there is no display name", () => {
    const html = renderMembersHtml([{ email: "c@d.com", name: "", role: "member" }]);
    expect(html).toContain(">—<");
    expect(html).toMatch(/member-row__email[^>]*>c@d\.com</);
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

describe("renderInviteLinksHtml", () => {
  it("renders a labeled row with expiry and revoke", () => {
    const html = renderInviteLinksHtml([
      { id: "l1", label: "for the design team", expiresAt: "2026-08-27T18:00:00.000Z" },
    ]);
    expect(html).toContain('data-link-id="l1"');
    expect(html).toContain("for the design team");
    expect(html).toContain("invite-link-row__revoke");
    expect(html).toContain("expires");
  });

  it("falls back to a generic label when none was set", () => {
    const html = renderInviteLinksHtml([
      { id: "l1", label: null, expiresAt: "2026-08-27T18:00:00.000Z" },
    ]);
    expect(html).toContain("Unlabeled link");
  });

  it("escapes the label", () => {
    const html = renderInviteLinksHtml([
      { id: "l1", label: "<script>alert(1)</script>", expiresAt: "2026-08-27T18:00:00.000Z" },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns empty string for no links", () => {
    expect(renderInviteLinksHtml([])).toBe("");
  });
});

describe("renderPeopleTableHtml", () => {
  it("wraps member and invite rows in one ws-table with a Name/Email/Role head", () => {
    const rows =
      renderMembersHtml([{ email: "a@b.com", name: "Ada", role: "owner" }]) +
      renderInvitesHtml([{ id: "i1", email: "p@x.com", status: "pending" }]);
    const html = renderPeopleTableHtml(rows);
    expect(html).toContain('class="ws-table"');
    expect(html).toContain('aria-label="People"');
    expect(html).toContain(">Name</th>");
    expect(html).toContain(">Email</th>");
    expect(html).toContain(">Role</th>");
    expect(html.match(/<tr/g)).toHaveLength(3); // head + member + invite
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

  it("meters hosted residue and adds the unmetered note when a BYO bucket is active", () => {
    const html = renderUsageHtml({
      bytes: 900,
      objects: 3,
      uploadsInPeriod: 2,
      maxStorageBytes: 1000,
      sharedBytes: 250,
      storageBudgetBasis: "shared",
    });
    expect(html).toContain("Hosted storage");
    expect(html).toContain("250 B of 1 KB");
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("unmetered");
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

describe("renderGalleriesTableHtml", () => {
  it("returns empty string for no galleries", () => {
    expect(renderGalleriesTableHtml([])).toBe("");
  });

  it("renders name, items, linked refs, and updated date", () => {
    const html = renderGalleriesTableHtml([
      {
        url: "https://uploads.sh/g/gal_1",
        title: "Launch media",
        description: "Ship shots",
        updatedAt: "2026-07-03T00:00:00.000Z",
        itemCount: 2,
        references: [
          {
            coordinate: "buildinternet/uploads#58",
            canonicalUrl: "https://github.com/buildinternet/uploads/pull/58",
          },
        ],
      },
    ]);
    expect(html).toContain("Launch media");
    expect(html).toContain("Ship shots");
    expect(html).toContain('href="https://uploads.sh/g/gal_1"');
    expect(html).toContain(">2<");
    expect(html).toContain("buildinternet/uploads#58");
    expect(html).toContain("https://github.com/buildinternet/uploads/pull/58");
    expect(html).toContain(formatGalleryDate("2026-07-03T00:00:00.000Z"));
  });

  it("escapes title/description and shows em dash when nothing is linked", () => {
    const html = renderGalleriesTableHtml([
      {
        url: "https://uploads.sh/g/gal_2",
        title: "<img src=x onerror=alert(1)>",
        description: "<b>x</b>",
        updatedAt: "not-a-date",
        itemCount: 0,
        references: [],
      },
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("—");
    expect(html).toContain("not-a-date");
  });

  it("caps linked refs at three and shows a +N remainder", () => {
    const refs = [1, 2, 3, 4, 5].map((n) => ({
      coordinate: `org/repo#${n}`,
      canonicalUrl: `https://github.com/org/repo/pull/${n}`,
    }));
    const html = renderGalleriesTableHtml([
      {
        url: "https://uploads.sh/g/gal_3",
        title: "Many links",
        description: null,
        updatedAt: "2026-07-01T00:00:00.000Z",
        itemCount: 1,
        references: refs,
      },
    ]);
    expect(html).toContain("org/repo#1");
    expect(html).toContain("org/repo#3");
    expect(html).not.toContain("org/repo#4");
    expect(html).toContain("+2");
  });
});

describe("renderGalleriesGridHtml", () => {
  it("returns empty string for no galleries", () => {
    expect(renderGalleriesGridHtml([])).toBe("");
  });

  it("renders a cover image, title, item count, and linked refs as cards", () => {
    const html = renderGalleriesGridHtml([
      {
        url: "https://uploads.sh/g/gal_1",
        title: "Launch media",
        description: "Ship shots",
        updatedAt: "2026-07-03T00:00:00.000Z",
        itemCount: 2,
        previewUrl: "https://embed.uploads.sh/acme/one.png",
        references: [
          {
            coordinate: "buildinternet/uploads#58",
            canonicalUrl: "https://github.com/buildinternet/uploads/pull/58",
          },
        ],
      },
    ]);
    expect(html).toContain("ws-gallery-grid");
    expect(html).toContain("ws-gallery-card");
    expect(html).toContain('src="https://embed.uploads.sh/acme/one.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("Launch media");
    expect(html).toContain("2 items");
    expect(html).toContain("buildinternet/uploads#58");
    // Cover opts into media-load's broken-image fallback: a data-media-load
    // root with a hidden glyph the binder reveals on a failed load.
    expect(html).toContain("data-media-load");
    expect(html).toContain("data-media-fallback");
    expect(html).toContain("ws-gallery-card__glyph");
  });

  it("uses a placeholder glyph and 'empty' label when there is no preview", () => {
    const html = renderGalleriesGridHtml([
      {
        url: "https://uploads.sh/g/gal_2",
        title: "No cover",
        description: null,
        updatedAt: "2026-07-01T00:00:00.000Z",
        itemCount: 0,
        previewUrl: null,
        references: [],
      },
    ]);
    expect(html).toContain("ws-gallery-card__cover--empty");
    expect(html).toContain("ws-gallery-card__glyph");
    expect(html).not.toContain("<img");
    expect(html).toContain("empty");
  });

  it("singularizes a one-item gallery", () => {
    const html = renderGalleriesGridHtml([
      {
        url: "https://uploads.sh/g/gal_3",
        title: "Solo",
        description: null,
        updatedAt: "2026-07-01T00:00:00.000Z",
        itemCount: 1,
        previewUrl: "https://embed.uploads.sh/acme/solo.png",
        references: [],
      },
    ]);
    expect(html).toContain("1 item");
    expect(html).not.toContain("1 items");
  });

  it("escapes a hostile title and preview URL", () => {
    const html = renderGalleriesGridHtml([
      {
        url: "https://uploads.sh/g/gal_4",
        title: "<img src=x onerror=alert(1)>",
        description: null,
        updatedAt: "2026-07-01T00:00:00.000Z",
        itemCount: 1,
        previewUrl: 'https://e.test/a.png" onerror="alert(1)',
        references: [],
      },
    ]);
    expect(html).not.toContain("<img src=x");
    // The preview URL lands in a double-quoted attribute; an embedded quote
    // must be escaped so it can't break out into an `onerror` handler.
    expect(html).not.toContain('.png" onerror=');
    expect(html).toContain("&lt;img");
  });
});

describe("renderGalleriesHtml / renderGalleriesViewToggleHtml", () => {
  const row = {
    url: "https://uploads.sh/g/gal_1",
    title: "Launch media",
    description: null,
    updatedAt: "2026-07-03T00:00:00.000Z",
    itemCount: 1,
    previewUrl: "https://embed.uploads.sh/acme/one.png",
    references: [],
  };

  it("dispatches to the grid for grid view and the table for list view", () => {
    expect(renderGalleriesHtml([row], "grid")).toContain("ws-gallery-grid");
    expect(renderGalleriesHtml([row], "list")).toContain("ws-table");
  });

  it("marks the active layout pressed in the toggle", () => {
    const grid = renderGalleriesViewToggleHtml("grid");
    expect(grid).toContain('data-gallery-view="grid" aria-pressed="true"');
    expect(grid).toContain('data-gallery-view="list" aria-pressed="false"');
    const list = renderGalleriesViewToggleHtml("list");
    expect(list).toContain('data-gallery-view="list" aria-pressed="true"');
  });

  it("grid placeholder reuses the grid card classes and is busy", () => {
    const html = renderGalleriesGridPlaceholderHtml(3);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("ws-gallery-card--skel");
    expect(html.match(/ws-gallery-card /g)?.length).toBe(3);
  });
});

describe("skeleton placeholders", () => {
  it("marks bars decorative so screen readers skip them", () => {
    const html = skeletonBarHtml("60%");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("ws-skel");
    expect(html).toContain("--ws-skel-w:60%");
  });

  it("drops a width that is not a plain CSS length", () => {
    // The value lands in a style attribute — a CSS context, where HTML
    // escaping would not help. Anything unrecognised falls back to the default.
    const html = skeletonBarHtml('60px;background:url("http://evil.test")');
    expect(html).toContain("--ws-skel-w:100%");
    expect(html).not.toContain("evil.test");
  });

  it("builds the usage placeholder from the same meter chrome as real usage", () => {
    const html = renderUsagePlaceholderHtml();
    // Same wrapper + row + track classes renderUsageHtml emits, so the swap
    // to real data cannot change the section's height.
    expect(html).toContain("ul-progress");
    expect(html).toContain("ul-progress__row");
    expect(html).toContain("ul-progress__track");
    // Two meters, matching renderUsageHtml's storage + uploads pair.
    expect(html.match(/ul-progress__row/g)).toHaveLength(2);
    // Empty track: no width to animate from a wrong starting point.
    expect(html).toContain("width:0%");
    expect(html).toContain('aria-busy="true"');
  });

  it("emits as many meter rows as the caller's `meters` guess", () => {
    // A caller expecting the workspace to land on the capless single-meter
    // shape (or any other guess) can say so instead of always assuming two.
    expect(renderUsagePlaceholderHtml(1).match(/ul-progress__row/g)).toHaveLength(1);
    expect(renderUsagePlaceholderHtml(3).match(/ul-progress__row/g)).toHaveLength(3);
  });

  it("builds a galleries placeholder with the real table chrome", () => {
    const html = renderGalleriesPlaceholderHtml(3);
    expect(html).toContain("ws-table-wrap");
    expect(html).toContain('class="ws-table"');
    // Same four column headers renderGalleriesTableHtml emits.
    expect(html).toContain(">Name<");
    expect(html).toContain(">Items<");
    expect(html).toContain(">Linked<");
    expect(html).toContain(">Updated<");
    expect(html.match(/<tr>/g)).toHaveLength(4); // 1 head + 3 body
    expect(html).toContain('aria-busy="true"');
  });

  it("defaults to three placeholder rows", () => {
    expect(renderGalleriesPlaceholderHtml().match(/<tr>/g)).toHaveLength(4);
  });

  it("mirrors the real people table's chrome and cell structure", () => {
    const html = renderMembersPlaceholderHtml(2);
    expect(html.match(/<tr/g)).toHaveLength(3); // 1 head + 2 body
    expect(html).toContain("ws-table");
    expect(html).toContain(">Name</th>");
    expect(html).toContain(">Email</th>");
    expect(html).toContain(">Role</th>");
  });
});

describe("renderEmptyStateHtml", () => {
  it("mirrors the shadcn Empty component's data-slot structure", () => {
    const html = renderEmptyStateHtml({ title: "No items", description: "Do a thing." });
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('data-slot="empty-header"');
    expect(html).toContain('data-slot="empty-title"');
    expect(html).toContain('data-slot="empty-description"');
    expect(html).toContain(">No items<");
    expect(html).toContain(">Do a thing.<");
  });

  it("escapes the title but leaves description/content as caller-trusted HTML", () => {
    const html = renderEmptyStateHtml({
      title: "<script>alert(1)</script>",
      description: 'Create a <a href="/x">thing</a>.',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="/x">thing</a>');
  });

  it("omits the description and content slots when not given", () => {
    const html = renderEmptyStateHtml({ title: "No items" });
    expect(html).not.toContain("empty-description");
    expect(html).not.toContain("empty-content");
  });

  it("renders the content slot for a trailing CTA", () => {
    const html = renderEmptyStateHtml({ title: "No items", content: "<button>Go</button>" });
    expect(html).toContain('data-slot="empty-content"');
    expect(html).toContain("<button>Go</button>");
  });

  it("defaults to the card variant's centered, bordered classes", () => {
    const html = renderEmptyStateHtml({ title: "No items" });
    expect(html).toContain("rounded-xl");
    expect(html).toContain("border-dashed");
    expect(html).toContain("items-center");
  });

  it("the inline variant drops the card chrome for a compact one-liner", () => {
    const html = renderEmptyStateHtml({ title: "No items", variant: "inline" });
    expect(html).not.toContain("rounded-xl");
    expect(html).not.toContain("border-dashed");
    expect(html).toContain("items-start");
  });
});

describe("renderGalleriesEmptyHtml", () => {
  const cmd = 'uploads gallery create --title "Release screenshots"';

  it("leads with the state, not with instructions", () => {
    const html = renderGalleriesEmptyHtml(cmd);
    const headlineAt = html.indexOf("No galleries yet");
    const commandAt = html.indexOf('data-slot="empty-content"');
    expect(headlineAt).toBeGreaterThanOrEqual(0);
    expect(commandAt).toBeGreaterThan(headlineAt);
  });

  it("renders as the Empty component's card variant", () => {
    const html = renderGalleriesEmptyHtml(cmd);
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain("rounded-xl");
  });

  it("carries the create command as the single primary action", () => {
    const html = renderGalleriesEmptyHtml(cmd);
    // `cmd` embeds double quotes (`--title "..."`), so the *safe* HTML must
    // entity-escape them — left raw, `data-copy="${cmd}"` would terminate at
    // the first embedded quote and corrupt the attribute. Assert on the
    // escaped form rather than the raw string.
    expect(html).toContain(escapeHtml(cmd));
    expect(html.match(/data-copy=/g)).toHaveLength(1);
  });

  it("escapes a command containing markup", () => {
    expect(renderGalleriesEmptyHtml('a<b>"c"')).not.toContain("<b>");
  });

  it("skips the restated body sentence — the page note and details block above/below it already cover it", () => {
    const html = renderGalleriesEmptyHtml(cmd);
    expect(html).not.toContain("empty-description");
    expect(html).not.toContain("public link");
  });
});

describe("placeholder builders reuse the real markup's classes", () => {
  it("renderWorkspacesPlaceholderHtml mirrors the real dev-links row shape", () => {
    const html = renderWorkspacesPlaceholderHtml(2);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('class="slug"');
  });

  it("renderDetailListPlaceholderHtml mirrors the real detail-list row shape", () => {
    const html = renderDetailListPlaceholderHtml(2);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("detail-main");
    expect(html).toContain("detail-title");
    expect(html).toContain("detail-meta");
  });

  it("renderFilesPlaceholderHtml mirrors the real toolbar + table chrome", () => {
    const html = renderFilesPlaceholderHtml(3);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("wft-filterbar");
    expect(html).toContain("wft-sectionhead");
    // Real column headers — static text, since they never depend on data.
    expect(html).toContain(">name<");
    expect(html).toContain(">visibility<");
    expect(html.match(/class="wft-row"/g)).toHaveLength(3);
  });
});
