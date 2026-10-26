import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Feed } from "../src/client.js";
import { applyLocalFeedLinks } from "../src/comment-live-link.js";
import { feedItemIdFor } from "../src/comment-render-scope.generated.js";
import type { AttachmentItem, GhTarget } from "../src/github.js";

const feed: Feed = {
  id: "feed_abcdefghijklmnopqrstuv",
  url: "https://uploads.test/c/feed_abcdefghijklmnopqrstuv",
  workspace: "acme",
  repo: "acme/web",
  path: null,
  number: 12,
  kind: "pull",
  title: "acme/web#12",
  createdAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
  items: [],
};

const pr: GhTarget = { repo: "Acme/Web", kind: "pull", num: 12 };

function item(name: string): AttachmentItem {
  const key = `gh/acme/web/pull/12/${name}`;
  return {
    key,
    url: `https://storage.uploads.sh/acme/${key}`,
    embedUrl: null,
    pageUrl: `https://uploads.test/f/acme/${key}`,
  };
}

describe("feedItemIdFor (CLI copy)", () => {
  it("matches the API's first 32 hex chars of sha256(key)", async () => {
    const key = "gh/acme/web/pull/12/a.png";
    expect(await feedItemIdFor(key)).toBe(
      createHash("sha256").update(key).digest("hex").slice(0, 32),
    );
  });
});

describe("applyLocalFeedLinks", () => {
  it("creates the PR live link without a source and links only in-scope items", async () => {
    const createFeed = vi.fn(async () => feed);
    const inScope = item("in.png");
    const moved = item("moved.png");
    const promoted = item("promoted.png");
    const untagged = item("untagged.png");
    const metadata = new Map<string, Record<string, string>>([
      [inScope.key, { "gh.repo": "acme/web", "gh.number": "12" }],
      [moved.key, { "gh.repo": "acme/web", "gh.number": "13" }],
      [promoted.key, { "gh.repo": "acme/web", "gh.number": "12", "gh.status": "promoted" }],
    ]);

    const url = await applyLocalFeedLinks(
      { createFeed },
      pr,
      [inScope, moved, promoted, untagged],
      metadata,
    );

    expect(url).toBe(feed.url);
    expect(createFeed).toHaveBeenCalledWith({ repo: "Acme/Web", pr: 12 });
    expect(inScope.pageUrl).toBe(`${feed.url}/${await feedItemIdFor(inScope.key)}`);
    expect(moved.pageUrl).toBe(`https://uploads.test/f/acme/${moved.key}`);
    expect(promoted.pageUrl).toBe(`https://uploads.test/f/acme/${promoted.key}`);
    expect(untagged.pageUrl).toBe(`https://uploads.test/f/acme/${untagged.key}`);
  });

  it("uses the issue field for an issue target", async () => {
    const createFeed = vi.fn(async () => ({ ...feed, kind: "issue" as const, number: 7 }));
    await applyLocalFeedLinks(
      { createFeed },
      { repo: "acme/web", kind: "issues", num: 7 },
      [item("a.png")],
      new Map(),
    );
    expect(createFeed).toHaveBeenCalledWith({ repo: "acme/web", issue: 7 });
  });

  it("returns null and leaves links alone when create fails (older server, network error)", async () => {
    const createFeed = vi.fn(async () => {
      throw new Error("Feed create failed.");
    });
    const inScope = item("in.png");
    const url = await applyLocalFeedLinks(
      { createFeed },
      pr,
      [inScope],
      new Map([[inScope.key, { "gh.repo": "acme/web", "gh.number": "12" }]]),
    );
    expect(url).toBeNull();
    expect(inScope.pageUrl).toBe(`https://uploads.test/f/acme/${inScope.key}`);
  });

  it("degrades without the line when the server returns a non-string url", async () => {
    const createFeed = vi.fn(async () => ({ ...feed, url: 42 }) as unknown as Feed);
    const inScope = item("in.png");
    const url = await applyLocalFeedLinks(
      { createFeed },
      pr,
      [inScope],
      new Map([[inScope.key, { "gh.repo": "acme/web", "gh.number": "12" }]]),
    );
    expect(url).toBeNull();
    expect(inScope.pageUrl).toBe(`https://uploads.test/f/acme/${inScope.key}`);
  });

  it("does not call create with no items or no createFeed method", async () => {
    const createFeed = vi.fn(async () => feed);
    expect(await applyLocalFeedLinks({ createFeed }, pr, [], new Map())).toBeNull();
    expect(createFeed).not.toHaveBeenCalled();
    expect(await applyLocalFeedLinks({}, pr, [item("a.png")], new Map())).toBeNull();
  });
});
