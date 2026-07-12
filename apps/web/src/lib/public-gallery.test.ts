import { describe, expect, it, vi } from "vitest";
import { fetchPublicGallery, isPublicGallery } from "./public-gallery";

const ID = "gal_abcdefghijklmnopqrstuv";
const gallery = {
  id: ID,
  title: "Launch <script>",
  description: "Line one\nLine two",
  visibility: "public",
  coverItemId: null,
  version: 1,
  createdAt: "2026-07-11T12:00:00.000Z",
  updatedAt: "2026-07-11T12:00:00.000Z",
  items: [
    {
      id: "item-1",
      filename: "screen.png",
      position: 1000,
      caption: "<img onerror=alert(1)>",
      altText: "Screenshot",
      status: "available",
      url: "https://storage.uploads.sh/screen.png",
      contentType: "image/png",
    },
  ],
  references: [
    {
      provider: "github",
      resourceType: "item",
      coordinate: "buildinternet/uploads#123",
      canonicalUrl: "https://github.com/buildinternet/uploads/issues/123",
    },
  ],
} as const;

describe("public gallery API", () => {
  it("accepts the bounded public DTO including multiline plain text", () => {
    expect(isPublicGallery(gallery)).toBe(true);
  });

  it("rejects control, zero-width, and bidirectional formatting characters", () => {
    expect(isPublicGallery({ ...gallery, title: "spoof\u202etitle" })).toBe(false);
    expect(isPublicGallery({ ...gallery, title: "zero\u200bwidth" })).toBe(false);
    expect(isPublicGallery({ ...gallery, title: "c1\u0085control" })).toBe(false);
  });

  it("rejects unsafe URLs, mismatched tombstones, invalid dates, and oversized lists", () => {
    expect(
      isPublicGallery({
        ...gallery,
        items: [{ ...gallery.items[0], url: "javascript:alert(1)" }],
      }),
    ).toBe(false);
    expect(
      isPublicGallery({
        ...gallery,
        items: [{ ...gallery.items[0], status: "missing" }],
      }),
    ).toBe(false);
    expect(isPublicGallery({ ...gallery, updatedAt: "not-a-date" })).toBe(false);
    expect(
      isPublicGallery({
        ...gallery,
        items: Array.from({ length: 101 }, () => gallery.items[0]),
      }),
    ).toBe(false);
  });

  it("bounds and sanitizes external references, tolerating their absence", () => {
    const { references: _references, ...withoutReferences } = gallery;
    expect(isPublicGallery(withoutReferences)).toBe(true);
    expect(
      isPublicGallery({
        ...gallery,
        references: [{ ...gallery.references[0], canonicalUrl: "javascript:alert(1)" }],
      }),
    ).toBe(false);
    expect(
      isPublicGallery({
        ...gallery,
        references: [{ ...gallery.references[0], coordinate: "bidi‮evil" }],
      }),
    ).toBe(false);
    expect(
      isPublicGallery({
        ...gallery,
        references: Array.from({ length: 21 }, () => gallery.references[0]),
      }),
    ).toBe(false);
  });

  it("normalizes a missing references field to an empty array", async () => {
    const { references: _references, ...withoutReferences } = gallery;
    await expect(
      fetchPublicGallery(ID, {
        origin: "https://api.uploads.sh",
        fetch: async () => Response.json(withoutReferences),
      }),
    ).resolves.toEqual({ status: "ok", gallery: { ...withoutReferences, references: [] } });
  });

  it("fetches one exact public endpoint without credentials or referrer", async () => {
    let seen: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { input, init };
      return Response.json(gallery);
    });
    await expect(
      fetchPublicGallery(ID, { origin: "https://api.uploads.sh", fetch: fetcher }),
    ).resolves.toEqual({ status: "ok", gallery });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(seen?.input)).toBe("https://api.uploads.sh/public/galleries/" + ID);
    expect(seen?.init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const headers = seen?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("maps malformed IDs and upstream responses without exposing details", async () => {
    const fetcher = vi.fn();
    await expect(
      fetchPublicGallery("bad", { origin: "https://api.uploads.sh", fetch: fetcher }),
    ).resolves.toEqual({ status: "not_found" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      fetchPublicGallery(ID, {
        origin: "https://api.uploads.sh",
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      fetchPublicGallery(ID, {
        origin: "https://api.uploads.sh",
        fetch: async () => new Response("nope", { status: 503 }),
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      fetchPublicGallery(ID, {
        origin: "https://api.uploads.sh",
        fetch: async () =>
          Response.json({
            ...gallery,
            items: [{ ...gallery.items[0], url: "http://unsafe.test" }],
          }),
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("permits HTTPS and loopback development origins only", async () => {
    const fetcher = vi.fn(async () => Response.json(gallery));
    await expect(
      fetchPublicGallery(ID, { origin: "http://evil.test", fetch: fetcher }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      fetchPublicGallery(ID, { origin: "http://127.0.0.1:8787", fetch: fetcher }),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      fetchPublicGallery(ID, { origin: "http://[::1]:8787", fetch: fetcher }),
    ).resolves.toMatchObject({ status: "ok" });
  });
});
