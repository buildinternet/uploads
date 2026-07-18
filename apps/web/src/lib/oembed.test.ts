import { describe, expect, it, vi } from "vitest";
import {
  ABSOLUTE_MAX_EDGE,
  DEFAULT_PHOTO_SIZE,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
  fitDimensions,
  oembedDiscoveryHref,
  oembedHttpResponse,
  parsePositiveInt,
  parseShareableUrl,
  resolveOEmbed,
  sharePageUrl,
} from "./oembed";

const SITE = "https://uploads.sh";
const API = "https://api.uploads.sh";
const GALLERY_ID = "gal_abcdefghijklmnopqrstuv";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const publicFile = {
  workspace: "acme",
  key: "screenshots/shot.png",
  url: "https://storage.uploads.sh/acme/screenshots/shot.png",
  embedUrl: "https://embed.uploads.sh/acme/screenshots/shot.png",
  size: 20480,
  contentType: "image/png",
  uploaded: "2026-07-13T12:00:00.000Z",
};

const publicVideo = {
  ...publicFile,
  key: "clips/demo.mp4",
  url: "https://storage.uploads.sh/acme/clips/demo.mp4",
  embedUrl: null,
  contentType: "video/mp4",
};

const publicGallery = {
  id: GALLERY_ID,
  title: "PR screenshots",
  description: "Before/after",
  visibility: "public" as const,
  coverItemId: "item_cover",
  version: 1,
  createdAt: "2026-07-13T12:00:00.000Z",
  updatedAt: "2026-07-13T13:00:00.000Z",
  items: [
    {
      id: "item_cover",
      filename: "before.png",
      position: 1,
      caption: null,
      altText: null,
      status: "available" as const,
      url: "https://storage.uploads.sh/acme/before.png",
      embedUrl: "https://embed.uploads.sh/acme/before.png",
      contentType: "image/png",
    },
    {
      id: "item_two",
      filename: "notes.txt",
      position: 2,
      caption: null,
      altText: null,
      status: "available" as const,
      url: "https://storage.uploads.sh/acme/notes.txt",
      embedUrl: null,
      contentType: "text/plain",
    },
  ],
  references: [],
};

describe("parseShareableUrl", () => {
  it("parses file, gallery, and gallery-item paths on the request origin", () => {
    expect(parseShareableUrl(`${SITE}/f/acme/screenshots/shot.png`, SITE)).toEqual({
      kind: "file",
      workspace: "acme",
      key: "screenshots/shot.png",
    });
    expect(parseShareableUrl(`${SITE}/g/${GALLERY_ID}`, SITE)).toEqual({
      kind: "gallery",
      id: GALLERY_ID,
    });
    expect(parseShareableUrl(`${SITE}/g/${GALLERY_ID}/item_cover`, SITE)).toEqual({
      kind: "gallery-item",
      id: GALLERY_ID,
      itemId: "item_cover",
    });
  });

  it("decodes path segments and rejects traversal / foreign origins", () => {
    expect(parseShareableUrl(`${SITE}/f/acme/My%20Shot%231.png`, SITE)).toEqual({
      kind: "file",
      workspace: "acme",
      key: "My Shot#1.png",
    });
    // Encoded slash keeps `..` inside a path segment through URL parsing; after
    // decode, isSafeKey rejects `..` components.
    expect(parseShareableUrl(`${SITE}/f/acme/..%2fetc%2fpasswd`, SITE)).toBeNull();
    // Bare / percent-encoded `../` path segments are collapsed by the URL
    // parser into a different path (not a client-controlled key under acme).
    expect(parseShareableUrl(`${SITE}/f/acme/../etc/passwd`, SITE)).toEqual({
      kind: "file",
      workspace: "etc",
      key: "passwd",
    });
    expect(parseShareableUrl(`https://evil.example/f/acme/shot.png`, SITE)).toBeNull();
    expect(parseShareableUrl(`${SITE}/docs`, SITE)).toBeNull();
    expect(parseShareableUrl(`${SITE}/g/not-a-gallery-id`, SITE)).toBeNull();
  });
});

describe("fitDimensions / parsePositiveInt", () => {
  it("clamps to maxwidth/maxheight preserving aspect ratio", () => {
    expect(fitDimensions(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(fitDimensions(1000, 2000, undefined, 500)).toEqual({ width: 250, height: 500 });
    expect(fitDimensions(100, 100, 50, 50)).toEqual({ width: 50, height: 50 });
  });

  it("parses positive integer query params and caps the absolute max edge", () => {
    expect(parsePositiveInt("800")).toBe(800);
    expect(parsePositiveInt("0")).toBeUndefined();
    expect(parsePositiveInt("-1")).toBeUndefined();
    expect(parsePositiveInt("12.5")).toBeUndefined();
    expect(parsePositiveInt(String(ABSOLUTE_MAX_EDGE + 10))).toBe(ABSOLUTE_MAX_EDGE);
  });
});

describe("oembedDiscoveryHref / sharePageUrl", () => {
  it("builds a discovery href with url + format=json", () => {
    const page = sharePageUrl(SITE, {
      kind: "file",
      workspace: "acme",
      key: "screenshots/shot.png",
    });
    const href = oembedDiscoveryHref(page, SITE);
    const parsed = new URL(href);
    expect(parsed.origin).toBe(SITE);
    expect(parsed.pathname).toBe("/oembed");
    expect(parsed.searchParams.get("url")).toBe(page);
    expect(parsed.searchParams.get("format")).toBe("json");
  });
});

describe("resolveOEmbed", () => {
  it("returns a photo response for an image file page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      expect(href).toContain("/public/files/acme/screenshots/shot.png");
      return jsonResponse(publicFile);
    });

    const page = sharePageUrl(SITE, {
      kind: "file",
      workspace: "acme",
      key: "screenshots/shot.png",
    });
    const result = await resolveOEmbed({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
      maxwidth: 600,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.body).toMatchObject({
      version: "1.0",
      type: "photo",
      provider_name: "uploads.sh",
      provider_url: SITE,
      title: "shot.png",
      url: publicFile.url,
      width: 600,
      height: 600,
    });
  });

  it("returns a video response with escaped HTML for a video file", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(publicVideo));
    const page = sharePageUrl(SITE, {
      kind: "file",
      workspace: "acme",
      key: "clips/demo.mp4",
    });
    const result = await resolveOEmbed({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.body.type).toBe("video");
    if (result.body.type !== "video") return;
    expect(result.body.width).toBe(DEFAULT_VIDEO_WIDTH);
    expect(result.body.height).toBe(DEFAULT_VIDEO_HEIGHT);
    expect(result.body.html).toContain(`src="${publicVideo.url}"`);
    expect(result.body.html).toContain("controls");
  });

  it("returns link + thumbnail for a gallery index", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(publicGallery));
    const page = sharePageUrl(SITE, { kind: "gallery", id: GALLERY_ID });
    const result = await resolveOEmbed({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.body).toMatchObject({
      type: "link",
      title: "PR screenshots",
      thumbnail_url: publicGallery.items[0]!.url,
      thumbnail_width: DEFAULT_PHOTO_SIZE,
      thumbnail_height: DEFAULT_PHOTO_SIZE,
    });
  });

  it("returns photo for a gallery item image", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(publicGallery));
    const page = sharePageUrl(SITE, {
      kind: "gallery-item",
      id: GALLERY_ID,
      itemId: "item_cover",
    });
    const result = await resolveOEmbed({
      url: page,
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: fetchMock as typeof fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.body).toMatchObject({
      type: "photo",
      title: "before.png",
      url: publicGallery.items[0]!.url,
    });
  });

  it("maps missing/private files and bad input to the right statuses", async () => {
    const notFound = await resolveOEmbed({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "missing.png" }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () => jsonResponse({ error: "nope" }, 404)) as typeof fetch,
    });
    expect(notFound.status).toBe("not_found");

    const authRequired = await resolveOEmbed({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "private.png" }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () =>
        jsonResponse(
          { error: { code: "auth_required", message: "Sign in required" } },
          401,
        )) as typeof fetch,
    });
    expect(authRequired.status).toBe("not_found");

    const bad = await resolveOEmbed({
      url: "",
      requestOrigin: SITE,
      apiOrigin: API,
    });
    expect(bad).toEqual({ status: "bad_request", message: "Missing or invalid url parameter." });

    const xml = await resolveOEmbed({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "shot.png" }),
      requestOrigin: SITE,
      apiOrigin: API,
      format: "xml",
    });
    expect(xml.status).toBe("not_implemented");

    const foreign = await resolveOEmbed({
      url: "https://evil.example/f/acme/shot.png",
      requestOrigin: SITE,
      apiOrigin: API,
    });
    expect(foreign.status).toBe("not_found");
  });

  it("surfaces API outages as unavailable", async () => {
    const result = await resolveOEmbed({
      url: sharePageUrl(SITE, { kind: "file", workspace: "acme", key: "shot.png" }),
      requestOrigin: SITE,
      apiOrigin: API,
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });
});

describe("oembedHttpResponse", () => {
  it("returns JSON + CORS on success and structured errors otherwise", async () => {
    const ok = oembedHttpResponse({
      status: "ok",
      body: {
        version: "1.0",
        type: "link",
        title: "x",
        provider_name: "uploads.sh",
        provider_url: SITE,
        cache_age: 300,
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(ok.headers.get("Content-Type")).toContain("application/json");
    expect(ok.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await ok.json()).toMatchObject({ type: "link", title: "x" });

    expect(oembedHttpResponse({ status: "not_found" }).status).toBe(404);
    expect(
      oembedHttpResponse({ status: "bad_request", message: "Missing or invalid url parameter." })
        .status,
    ).toBe(400);
    expect(
      oembedHttpResponse({ status: "not_implemented", message: "Only format=json is supported." })
        .status,
    ).toBe(501);
    expect(oembedHttpResponse({ status: "unavailable" }).status).toBe(503);
  });
});
