import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadsClient } from "../src/client.js";
import { runGallery, type CliContext } from "../src/commands.js";

function gallery(version: number) {
  return {
    id: "gal_example",
    url: "https://uploads.test/g/gal_example",
    workspace: "test",
    title: "Test gallery",
    description: null,
    visibility: "public" as const,
    coverItemId: null,
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [],
  };
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json: true,
    quiet: true,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runGallery", () => {
  it("adds keys sequentially with a fresh expectedVersion and API-returned URL", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let reads = 0;
    const versions: number[] = [];
    const client = {
      getGallery: async () => gallery(++reads),
      addGalleryItem: async (_id: string, objectKey: string, opts: { expectedVersion: number }) => {
        versions.push(opts.expectedVersion);
        return {
          id: `item-${objectKey}`,
          objectKey,
          position: opts.expectedVersion * 1000,
          caption: null,
          altText: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "available" as const,
          url: "https://storage.test/item",
          contentType: "image/png",
          size: 1,
        };
      },
    } as unknown as UploadsClient;

    const code = await runGallery(ctxWith(client), ["add", "gal_example", "one.png", "two.png"]);
    expect(code).toBe(0);
    expect(versions).toEqual([1, 2]);
    const output = JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""));
    expect(output.galleryUrl).toBe("https://uploads.test/g/gal_example");
  });

  it("reports individual add failures without skipping later keys", async () => {
    let reads = 0;
    const attempted: string[] = [];
    const client = {
      getGallery: async () => gallery(++reads),
      addGalleryItem: async (_id: string, objectKey: string) => {
        attempted.push(objectKey);
        if (objectKey === "missing.png") throw new Error("Object not found");
        return {
          id: `item-${objectKey}`,
          objectKey,
          position: 1000,
          caption: null,
          altText: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "available" as const,
          url: "https://storage.test/item",
          contentType: "image/png",
          size: 1,
        };
      },
    } as unknown as UploadsClient;

    const code = await runGallery(ctxWith(client), [
      "add",
      "gal_example",
      "first.png",
      "missing.png",
      "last.png",
    ]);
    expect(code).toBe(1);
    expect(attempted).toEqual(["first.png", "missing.png", "last.png"]);
  });
});

it("links GitHub coordinates after reading the current gallery version", async () => {
  const versions: number[] = [];
  const client = {
    getGallery: async () => gallery(7),
    linkGalleryExternalReference: async (
      _id: string,
      opts: { expectedVersion: number; coordinate: string },
    ) => {
      versions.push(opts.expectedVersion);
      expect(opts.coordinate).toBe("buildinternet/uploads#58");
      return {
        id: "ref-1",
        provider: "github" as const,
        resourceType: "item" as const,
        coordinate: opts.coordinate,
        canonicalUrl: "https://github.com/buildinternet/uploads/issues/58",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
  } as unknown as UploadsClient;

  expect(
    await runGallery(ctxWith(client), [
      "link",
      "gal_example",
      "--github",
      "https://github.com/BuildInternet/Uploads/pull/58",
    ]),
  ).toBe(0);
  expect(versions).toEqual([7]);
});

it("treats an absent GitHub reference as an idempotent unlink", async () => {
  const client = {
    listGalleryExternalReferences: async () => ({ references: [] }),
    getGallery: async () => {
      throw new Error("should not read version when reference is absent");
    },
  } as unknown as UploadsClient;

  expect(
    await runGallery(ctxWith(client), [
      "unlink",
      "gal_example",
      "--github",
      "buildinternet/uploads#58",
    ]),
  ).toBe(0);
});

it("uses reverse lookup for gallery list --github", async () => {
  const coordinates: string[] = [];
  const client = {
    findGalleriesByReference: async (opts: { coordinate: string }) => {
      coordinates.push(opts.coordinate);
      return { galleries: [gallery(1)], nextCursor: null };
    },
  } as unknown as UploadsClient;

  expect(
    await runGallery(ctxWith(client), [
      "list",
      "--github",
      "https://github.com/buildinternet/uploads/issues/58",
    ]),
  ).toBe(0);
  expect(coordinates).toEqual(["buildinternet/uploads#58"]);
});
