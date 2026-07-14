import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());

describe("put metadata headers", () => {
  it("emits X-Uploads-Meta-<key> headers for metadata alongside provenance", async () => {
    let seenHeaders: Headers | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          workspace: "test",
          key: "screenshots/a.png",
          url: "https://storage.test/a.png",
          size: 1,
          contentType: "image/png",
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    await client.put(new Uint8Array([1]), {
      filename: "a.png",
      key: "screenshots/a.png",
      provenance: { client: "uploads-cli" },
      metadata: { app: "myapp", "gh.repo": "buildinternet/uploads" },
    });

    expect(seenHeaders?.get("X-Uploads-Meta-client")).toBe("uploads-cli");
    expect(seenHeaders?.get("X-Uploads-Meta-app")).toBe("myapp");
    expect(seenHeaders?.get("X-Uploads-Meta-gh.repo")).toBe("buildinternet/uploads");
  });

  it("omits metadata headers entirely when metadata is not provided", async () => {
    let seenHeaders: Headers | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          workspace: "test",
          key: "screenshots/a.png",
          url: "https://storage.test/a.png",
          size: 1,
          contentType: "image/png",
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    await client.put(new Uint8Array([1]), { filename: "a.png", key: "screenshots/a.png" });

    expect(
      [...seenHeaders!.keys()].some((k) => k.toLowerCase().startsWith("x-uploads-meta-")),
    ).toBe(false);
  });
});

describe("metadata CRUD client methods", () => {
  it("getMetadata GETs the key-at-tail route with ?metadata=1", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.test/v1/test/files/screenshots/a.png?metadata=1");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ metadata: { app: "myapp" } }));
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    expect(await client.getMetadata("screenshots/a.png")).toEqual({ metadata: { app: "myapp" } });
  });

  it("patchMetadata PATCHes { set, delete } to the key-at-tail route and returns the merged map", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.test/v1/test/files/screenshots/a.png");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      expect(body).toEqual({ set: { app: "myapp" }, delete: ["page"] });
      return new Response(JSON.stringify({ metadata: { app: "myapp" } }));
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    expect(
      await client.patchMetadata("screenshots/a.png", { set: { app: "myapp" }, delete: ["page"] }),
    ).toEqual({ metadata: { app: "myapp" } });
  });

  it("findFiles sends repeatable ANDed meta.<key> params plus prefix/limit", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/test/files");
      expect(url.searchParams.getAll("meta.gh.repo")).toEqual(["buildinternet/uploads"]);
      expect(url.searchParams.getAll("meta.gh.number")).toEqual(["123"]);
      expect(url.searchParams.get("prefix")).toBe("gh/");
      expect(url.searchParams.get("limit")).toBe("10");
      return new Response(
        JSON.stringify({
          items: [{ key: "gh/o/r/pull/123/a.png", url: "https://x.test/a.png", metadata: {} }],
          cursor: null,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    const result = await client.findFiles(
      { "gh.repo": "buildinternet/uploads", "gh.number": "123" },
      { prefix: "gh/", limit: 10 },
    );
    expect(result.items[0].key).toBe("gh/o/r/pull/123/a.png");
    expect(result.cursor).toBeNull();
  });
});
