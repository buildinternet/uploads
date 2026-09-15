import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

const feed = {
  id: "feed_example",
  url: "https://uploads.test/feed/feed_example",
  workspace: "test",
  repo: "acme/app",
  path: null,
  number: null,
  kind: null,
  title: "acme/app",
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
  items: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("feed client methods", () => {
  it("uses workspace-scoped API paths and preserves the returned canonical URL", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/feeds") && init?.method === "POST") {
        expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({
          repo: "acme/app",
          number: 12,
          kind: "pull",
        });
        return new Response(JSON.stringify(feed), { status: 201 });
      }
      if (url.includes("/feeds?") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ feeds: [feed], nextCursor: null }));
      }
      if (url.endsWith("/feeds/feed_example") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(feed));
      }
      if (url.endsWith("/feeds/feed_example") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true, id: "feed_example" }));
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    const created = await client.createFeed({ repo: "acme/app", number: 12, kind: "pull" });
    expect(created.url).toBe("https://uploads.test/feed/feed_example");
    expect(await client.getFeed(created.id)).toEqual(feed);
    expect((await client.listFeeds({ limit: 10 })).feeds[0]?.url).toBe(feed.url);
    expect(await client.deleteFeed(created.id)).toEqual({ deleted: true, id: "feed_example" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.test/v1/workspaces/test/feeds");
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.test/v1/workspaces/test/feeds/feed_example");
    expect(fetch.mock.calls[2]?.[0]).toBe("https://api.test/v1/workspaces/test/feeds?limit=10");
    expect(fetch.mock.calls[3]?.[0]).toBe("https://api.test/v1/workspaces/test/feeds/feed_example");
  });
});
