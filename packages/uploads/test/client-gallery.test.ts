import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

const gallery = {
  id: "gal_example",
  url: "https://uploads.test/g/gal_example",
  workspace: "test",
  title: "Test gallery",
  description: null,
  visibility: "public",
  coverItemId: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  items: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("gallery client methods", () => {
  it("uses workspace-scoped API paths and preserves the returned canonical URL", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/galleries") && init?.method === "POST") {
        expect(init?.body).toBeInstanceOf(Uint8Array);
        return new Response(JSON.stringify(gallery), { status: 201 });
      }
      if (url.includes("/galleries?") && init?.method === "GET") {
        return new Response(JSON.stringify({ galleries: [gallery], nextCursor: null }));
      }
      if (url.endsWith("/galleries/gal_example") && init?.method === "GET") {
        return new Response(JSON.stringify(gallery));
      }
      if (url.endsWith("/galleries/gal_example") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true, id: "gal_example" }));
      }
      if (url.includes("/items")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            id: "item-1",
            objectKey: "screenshots/a.png",
            position: 1000,
            caption: null,
            altText: null,
            createdAt: gallery.createdAt,
            status: "available",
            url: "https://storage.test/a.png",
            contentType: "image/png",
            size: 1,
          }),
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    const created = await client.createGallery({ title: "Test gallery" });
    expect(created.url).toBe("https://uploads.test/g/gal_example");
    expect(await client.getGallery(created.id)).toEqual(gallery);
    expect((await client.listGalleries({ limit: 10 })).galleries[0].url).toBe(gallery.url);
    await client.addGalleryItem(created.id, "screenshots/a.png", { expectedVersion: 1 });
    expect(await client.deleteGallery(created.id, { expectedVersion: 1 })).toEqual({
      deleted: true,
      id: "gal_example",
    });
    expect(fetch.mock.calls[0][0]).toBe("https://api.test/v1/test/galleries");
    expect(fetch.mock.calls[1][0]).toBe("https://api.test/v1/test/galleries/gal_example");
    expect(fetch.mock.calls[2][0]).toBe("https://api.test/v1/test/galleries?limit=10");
    expect(fetch.mock.calls[3][0]).toBe("https://api.test/v1/test/galleries/gal_example/items");
    expect(fetch.mock.calls[4][0]).toBe("https://api.test/v1/test/galleries/gal_example");
  });
});

describe("gallery external-reference client methods", () => {
  it("uses workspace-scoped reference paths and encodes reverse lookup queries", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/galleries/gal_example/external-references") && init?.method === "GET")
        return new Response(JSON.stringify({ references: [] }));
      if (url.endsWith("/galleries/gal_example/external-references") && init?.method === "POST")
        return new Response(
          JSON.stringify({
            id: "ref-1",
            provider: "github",
            resourceType: "item",
            coordinate: "buildinternet/uploads#58",
            canonicalUrl: "https://github.com/buildinternet/uploads/issues/58",
            createdAt: gallery.createdAt,
          }),
          { status: 201 },
        );
      if (
        url.endsWith("/galleries/gal_example/external-references/ref-1") &&
        init?.method === "DELETE"
      )
        return new Response(JSON.stringify({ deleted: true, id: "ref-1" }));
      if (url.includes("/galleries/by-reference?") && init?.method === "GET")
        return new Response(JSON.stringify({ galleries: [gallery], nextCursor: null }));
      throw new Error("unexpected URL: " + url);
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    await client.listGalleryExternalReferences("gal_example");
    await client.linkGalleryExternalReference("gal_example", {
      expectedVersion: 1,
      provider: "github",
      coordinate: "buildinternet/uploads#58",
    });
    await client.unlinkGalleryExternalReference("gal_example", "ref-1", { expectedVersion: 2 });
    await client.findGalleriesByReference({
      provider: "github",
      coordinate: "buildinternet/uploads#58",
      limit: 10,
      cursor: "next",
    });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/v1/test/galleries/gal_example/external-references",
      "https://api.test/v1/test/galleries/gal_example/external-references",
      "https://api.test/v1/test/galleries/gal_example/external-references/ref-1",
      "https://api.test/v1/test/galleries/by-reference?provider=github&coordinate=buildinternet%2Fuploads%2358&limit=10&cursor=next",
    ]);
  });
});
