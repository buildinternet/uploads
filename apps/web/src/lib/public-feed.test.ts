import { describe, expect, it, vi } from "vitest";
import {
  applyPublicFeedHeaders,
  feedItemPath,
  feedPageCopy,
  feedPath,
  legacyFeedRedirectPath,
  fetchPublicFeed,
  fetchPublicFeedItem,
  isPublicFeed,
  isPublicFeedItemPage,
} from "./public-feed";
import { PUBLIC_GALLERY_CSP } from "./public-gallery";

const ID = "feed_abcdefghijklmnopqrstuv";
const feed = {
  id: ID,
  title: "acme/app · /settings",
  repo: "acme/app",
  path: "/settings",
  number: null,
  kind: null,
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
  items: [
    {
      id: "a".repeat(32),
      filename: "after.png",
      status: "available" as const,
      url: "https://storage.uploads.sh/after.png",
      embedUrl: "https://embed.uploads.sh/after.png",
      contentType: "image/png",
      size: 20480,
      uploaded: "2026-09-15T12:00:00.000Z",
      path: "/settings",
      state: "after",
    },
  ],
};

describe("feed paths", () => {
  it("builds list and item paths", () => {
    expect(feedPath(ID)).toBe(`/c/${ID}`);
    expect(feedItemPath(ID, "a".repeat(32))).toBe(`/c/${ID}/${"a".repeat(32)}`);
  });

  it("rewrites legacy /feed paths to /c", () => {
    expect(legacyFeedRedirectPath("/feed")).toBe("/c");
    expect(legacyFeedRedirectPath("/feed/")).toBe("/c");
    expect(legacyFeedRedirectPath(`/feed/${ID}`)).toBe(`/c/${ID}`);
    expect(legacyFeedRedirectPath(`/feed/${ID}/item-1`)).toBe(`/c/${ID}/item-1`);
    expect(legacyFeedRedirectPath("/feedback")).toBeNull();
    expect(legacyFeedRedirectPath("/c/feed_abc")).toBeNull();
  });
});

describe("feedPageCopy", () => {
  it("labels a repo feed, a pull request, and an issue", () => {
    expect(feedPageCopy({ repo: "acme/app", number: null, kind: null })).toEqual({
      eyebrow: "Live link · repo",
      scopeLabel: "acme/app",
      scopeNoun: "repo",
    });
    expect(feedPageCopy({ repo: "acme/app", number: 12, kind: "pull" })).toEqual({
      eyebrow: "Live link · pull request",
      scopeLabel: "acme/app#12",
      scopeNoun: "pull request",
    });
    expect(feedPageCopy({ repo: "acme/app", number: 9, kind: "issue" })).toEqual({
      eyebrow: "Live link · issue",
      scopeLabel: "acme/app#9",
      scopeNoun: "issue",
    });
  });
});

describe("public feed headers", () => {
  it("reuses the public gallery noindex posture", () => {
    const headers = new Headers();
    applyPublicFeedHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBe(PUBLIC_GALLERY_CSP);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });
});

describe("public feed API", () => {
  it("accepts a bounded github label and rejects a spoofed one", () => {
    expect(isPublicFeed({ ...feed, github: null })).toBe(true);
    expect(isPublicFeed({ ...feed, github: { title: "Fix nav", state: "open" } })).toBe(true);
    expect(isPublicFeed({ ...feed, github: { title: null, state: null } })).toBe(true);
    expect(isPublicFeed({ ...feed, github: { title: "x\u202ey", state: "open" } })).toBe(false);
    expect(isPublicFeed({ ...feed, github: { title: "ok", state: "draft" } })).toBe(false);
  });

  it("accepts the bounded public DTO", () => {
    expect(isPublicFeed(feed)).toBe(true);
    expect(
      isPublicFeed({
        ...feed,
        title: "acme/app#12",
        number: 12,
        kind: "pull",
      }),
    ).toBe(true);
  });

  it("rejects a gallery id and leaked workspace fields", () => {
    expect(isPublicFeed({ ...feed, id: "gal_abcdefghijklmnopqrstuv" })).toBe(false);
    expect(isPublicFeed({ ...feed, title: "spoof\u202etitle" })).toBe(false);
  });

  it("fetches /public/feeds/:id and maps 404", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`https://api.uploads.sh/public/feeds/${ID}`);
      return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(await fetchPublicFeed(ID, { origin: "https://api.uploads.sh", fetch })).toEqual({
      status: "ok",
      feed,
    });

    const missing = vi.fn(async () => new Response("gone", { status: 404 }));
    expect(await fetchPublicFeed(ID, { origin: "https://api.uploads.sh", fetch: missing })).toEqual(
      {
        status: "not_found",
      },
    );
    expect(
      await fetchPublicFeed("gal_abcdefghijklmnopqrstuv", { origin: "https://api.uploads.sh" }),
    ).toEqual({
      status: "not_found",
    });
  });
});

describe("public feed paging", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the cursor and accepts nextCursor", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`https://api.uploads.sh/public/feeds/${ID}?cursor=abc_DEF-123`);
      return json({ ...feed, nextCursor: "next_PAGE-1" });
    });
    const result = await fetchPublicFeed(ID, {
      origin: "https://api.uploads.sh",
      fetch,
      cursor: "abc_DEF-123",
    });
    expect(result).toEqual({ status: "ok", feed: { ...feed, nextCursor: "next_PAGE-1" } });
  });

  it("treats a malformed cursor as a missing page without fetching", async () => {
    const fetch = vi.fn();
    expect(
      await fetchPublicFeed(ID, { origin: "https://api.uploads.sh", fetch, cursor: "<script>" }),
    ).toEqual({ status: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a 400 for a cursor to not_found, and a 400 without one to unavailable", async () => {
    const bad = vi.fn(async () => new Response("bad", { status: 400 }));
    expect(
      await fetchPublicFeed(ID, { origin: "https://api.uploads.sh", fetch: bad, cursor: "stale" }),
    ).toEqual({ status: "not_found" });
    expect(await fetchPublicFeed(ID, { origin: "https://api.uploads.sh", fetch: bad })).toEqual({
      status: "unavailable",
    });
  });

  it("rejects a nextCursor with unsafe characters", () => {
    expect(isPublicFeed({ ...feed, nextCursor: "a b" })).toBe(false);
    expect(isPublicFeed({ ...feed, nextCursor: null })).toBe(true);
  });
});

describe("public feed item endpoint", () => {
  const ITEM = "a".repeat(32);
  const page = {
    feed: { id: ID, title: "acme/app#12", repo: "acme/app", number: 12, kind: "pull" },
    item: feed.items[0],
    prev: null,
    next: "b".repeat(32),
    index: 60,
    total: 75,
  };

  it("fetches /public/feeds/:id/items/:item", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`https://api.uploads.sh/public/feeds/${ID}/items/${ITEM}`);
      return new Response(JSON.stringify(page), { status: 200 });
    });
    expect(
      await fetchPublicFeedItem(ID, ITEM, { origin: "https://api.uploads.sh", fetch }),
    ).toEqual({ status: "ok", page });
  });

  it("rejects a malformed item id without fetching and maps 404", async () => {
    const fetch = vi.fn(async () => new Response("gone", { status: 404 }));
    expect(
      await fetchPublicFeedItem(ID, "not-an-id", { origin: "https://api.uploads.sh", fetch }),
    ).toEqual({ status: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await fetchPublicFeedItem(ID, ITEM, { origin: "https://api.uploads.sh", fetch }),
    ).toEqual({ status: "not_found" });
  });

  it("validates the page shape", () => {
    expect(isPublicFeedItemPage(page)).toBe(true);
    expect(isPublicFeedItemPage({ ...page, index: 75 })).toBe(false);
    expect(isPublicFeedItemPage({ ...page, prev: "../x" })).toBe(false);
    expect(isPublicFeedItemPage({ ...page, feed: { ...page.feed, kind: "branch" } })).toBe(false);
  });
});
