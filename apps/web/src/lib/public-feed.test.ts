import { describe, expect, it, vi } from "vitest";
import {
  applyPublicFeedHeaders,
  feedItemPath,
  feedPageCopy,
  feedPath,
  legacyFeedRedirectPath,
  fetchPublicFeed,
  isPublicFeed,
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
      eyebrow: "Repo change feed",
      scopeLabel: "acme/app",
      scopeNoun: "repo",
    });
    expect(feedPageCopy({ repo: "acme/app", number: 12, kind: "pull" })).toEqual({
      eyebrow: "Pull request feed",
      scopeLabel: "acme/app#12",
      scopeNoun: "pull request",
    });
    expect(feedPageCopy({ repo: "acme/app", number: 9, kind: "issue" })).toEqual({
      eyebrow: "Issue feed",
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
