import { describe, expect, it, vi } from "vitest";
import { embedHttpResponse, EMBED_PLAYER_CSP, resolveEmbedPlayer } from "./embed-player";
import { sharePageUrl } from "./oembed";

const SITE = "https://uploads.sh";
const API = "https://api.uploads.sh";
const FEED_ID = "feed_abcdefghijklmnopqrstuv";
const ITEM_ID = "a".repeat(32);
const MP4 = "https://storage.uploads.sh/acme/clips/demo.mp4";
const POSTER = "https://storage.uploads.sh/acme/_internal/posters/clips/demo.mp4.jpg";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const publicVideo = {
  workspace: "acme",
  key: "clips/demo.mp4",
  url: MP4,
  embedUrl: null,
  size: 20480,
  contentType: "video/mp4",
  uploaded: "2026-07-13T12:00:00.000Z",
  posterUrl: POSTER,
  videoDimensions: { width: 1920, height: 1080 },
};

describe("resolveEmbedPlayer", () => {
  it("returns a frameable video document for a public file", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/public/files/acme/clips/demo.mp4");
      return jsonResponse(publicVideo);
    });
    const page = sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "clips/demo.mp4" });
    const result = await resolveEmbedPlayer({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.html).toContain(
      `<video src="${MP4}" poster="https://storage.uploads.sh/cdn-cgi/image/width=1200,quality=82,fit=scale-down,format=jpeg,onerror=redirect/acme/_internal/posters/clips/demo.mp4.jpg"`,
    );
    expect(result.html).toContain("controls playsinline");
    expect(result.html).not.toContain("<script");

    const response = embedHttpResponse(result);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(EMBED_PLAYER_CSP);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors *");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("plays a public live-link video and ignores a withheld or image item", async () => {
    const page = sharePageUrl(SITE, { kind: "feed-item", id: FEED_ID, itemId: ITEM_ID });
    const video = await resolveEmbedPlayer({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () =>
        jsonResponse({
          feed: { id: FEED_ID, title: "acme/app#12", repo: "acme/app", number: 12, kind: "pull" },
          item: {
            id: ITEM_ID,
            filename: "demo.mp4",
            status: "available",
            url: MP4,
            embedUrl: null,
            contentType: "video/mp4",
            size: 1000,
            path: null,
            state: null,
            posterUrl: POSTER,
            videoDimensions: { width: 640, height: 360 },
          },
          prev: null,
          next: null,
          index: 0,
          total: 1,
        })) as typeof fetch,
    });
    expect(video.status).toBe("ok");
    if (video.status !== "ok") return;
    expect(video.html).toContain(`src="${MP4}"`);

    const withheld = await resolveEmbedPlayer({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () =>
        jsonResponse({
          feed: { id: FEED_ID, title: "acme/app#12", repo: "acme/app", number: 12, kind: "pull" },
          item: {
            id: ITEM_ID,
            filename: "secret.mp4",
            status: "withheld",
            url: null,
            embedUrl: null,
            contentType: null,
            size: null,
            path: null,
            state: null,
          },
          prev: null,
          next: null,
          index: 0,
          total: 1,
        })) as typeof fetch,
    });
    expect(withheld.status).toBe("not_found");
    const hidden = embedHttpResponse(withheld);
    const hiddenBody = await hidden.text();
    expect(hidden.status).toBe(404);
    expect(hiddenBody).not.toContain("secret");
    expect(hiddenBody).not.toContain(MP4);
  });

  it("does not echo a private file URL and does not fetch a foreign origin", async () => {
    const privatePage = sharePageUrl(SITE, {
      kind: "file",
      workspace: "acme",
      key: "clips/secret.mp4",
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "auth_required", message: "Sign in required" } }, 401),
    );
    const result = await resolveEmbedPlayer({
      url: privatePage,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
    });
    expect(result.status).toBe("not_found");
    const body = await embedHttpResponse(result).text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("storage.uploads.sh");

    const foreignFetch = vi.fn();
    const foreign = await resolveEmbedPlayer({
      url: "https://evil.example/f/acme/clips/demo.mp4",
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: foreignFetch as typeof fetch,
    });
    expect(foreign.status).toBe("not_found");
    expect(foreignFetch).not.toHaveBeenCalled();
  });

  it("404s an image and a collection, and surfaces API outages", async () => {
    const image = await resolveEmbedPlayer({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "shot.png" }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () =>
        jsonResponse({
          ...publicVideo,
          key: "shot.png",
          url: "https://storage.uploads.sh/acme/shot.png",
          contentType: "image/png",
          posterUrl: null,
          videoDimensions: undefined,
        })) as typeof fetch,
    });
    expect(image.status).toBe("not_found");
    expect(await embedHttpResponse(image).text()).not.toContain("shot.png");

    const feed = await resolveEmbedPlayer({
      url: sharePageUrl(SITE, { kind: "feed", id: FEED_ID }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: vi.fn() as typeof fetch,
    });
    expect(feed.status).toBe("not_found");

    const down = await resolveEmbedPlayer({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "clips/demo.mp4" }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
    });
    expect(down.status).toBe("unavailable");
    expect(embedHttpResponse(down).status).toBe(503);
  });
});
