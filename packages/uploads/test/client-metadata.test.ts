import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient, FIND_FILES_MAX_PAGES } from "../src/client.js";

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
      expect(String(input)).toBe(
        "https://api.test/v1/workspaces/test/files/screenshots/a.png?metadata=1",
      );
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
      expect(String(input)).toBe("https://api.test/v1/workspaces/test/files/screenshots/a.png");
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
      expect(url.pathname).toBe("/v1/workspaces/test/files/search");
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

  it("findFiles sends ?name= with optional empty filters", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/workspaces/test/files/search");
      expect(url.searchParams.get("name")).toBe("hero");
      expect(url.searchParams.getAll("meta.app")).toEqual(["web"]);
      return new Response(
        JSON.stringify({
          items: [{ key: "f/hero.png", url: "https://x.test/hero.png", metadata: { app: "web" } }],
          cursor: null,
          truncated: false,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    const result = await client.findFiles({ app: "web" }, { name: "hero" });
    expect(result.items[0].key).toBe("f/hero.png");
    expect(result.truncated).toBe(false);
  });

  it("findFiles forwards the cursor and surfaces the server's next cursor", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("cursor")).toBe("c0");
      return new Response(JSON.stringify({ items: [], cursor: "c1", truncated: true }));
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    const result = await client.findFiles({ app: "web" }, { cursor: "c0" });
    expect(result.cursor).toBe("c1");
    expect(result.truncated).toBe(true);
  });

  it("findFilesAll follows the cursor but stops at the page cap", async () => {
    // Server never runs out of pages — the drain has to stop itself.
    let calls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      const seq = String(calls);
      const url = new URL(String(input));
      expect(url.searchParams.get("cursor")).toBe(calls === 1 ? null : String(calls - 1));
      return new Response(
        JSON.stringify({ items: [{ key: `f/${seq}.png`, url: null, metadata: {} }], cursor: seq }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    const result = await client.findFilesAll({ app: "web" }, {}, 3);
    expect(calls).toBe(3);
    expect(result.items.map((item) => item.key)).toEqual(["f/1.png", "f/2.png", "f/3.png"]);
    // Non-null cursor means the cap stopped the drain, not the server.
    expect(result.cursor).toBe("3");
  });

  it("findFilesAll stops early when the server returns a null cursor", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ items: [{ key: "f/only.png", url: null, metadata: {} }], cursor: null }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    const result = await client.findFilesAll({ app: "web" });
    expect(calls).toBe(1);
    expect(result.cursor).toBeNull();
  });

  it("findFilesAll falls back to the default cap for a non-finite maxPages", async () => {
    // Infinity would otherwise remove the bound entirely, and NaN would make
    // the loop run zero times and return an empty result that looks complete.
    for (const maxPages of [Number.POSITIVE_INFINITY, Number.NaN, 0, -5]) {
      let calls = 0;
      const fetch = vi.fn(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            items: [{ key: `f/${calls}.png`, url: null, metadata: {} }],
            cursor: "c",
          }),
        );
      });
      vi.stubGlobal("fetch", fetch);
      const client = createUploadsClient({
        apiUrl: "https://api.test",
        workspace: "test",
        token: "up_test_x",
      });
      const result = await client.findFilesAll({ app: "web" }, {}, maxPages);
      expect(calls).toBe(FIND_FILES_MAX_PAGES);
      expect(result.cursor).toBe("c");
    }
  });

  it("listMetadataKeys GETs /files/facets", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.test/v1/workspaces/test/files/facets");
      return new Response(
        JSON.stringify({
          keys: [{ key: "app", count: 2, distinctValues: 1 }],
          truncated: false,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    expect(await client.listMetadataKeys()).toEqual({
      keys: [{ key: "app", count: 2, distinctValues: 1 }],
      truncated: false,
    });
  });

  it("listMetadataValues GETs /files/facets?key=", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.test/v1/workspaces/test/files/facets?key=app");
      return new Response(
        JSON.stringify({
          key: "app",
          values: [{ value: "web", count: 2 }],
          truncated: false,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });
    expect(await client.listMetadataValues("app")).toEqual({
      key: "app",
      values: [{ value: "web", count: 2 }],
      truncated: false,
    });
  });
});

describe("list metadata hydration", () => {
  it("requests metadata=1 and surfaces the hydrated map on list rows", async () => {
    let seenUrl = "";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          files: [
            {
              key: "gh/acme/web/pull/12/before.webp",
              url: "https://storage.test/before.webp",
              metadata: { path: "/settings", state: "before" },
            },
          ],
          cursor: null,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    const items = await client.listAll({ prefix: "gh/acme/web/pull/12/", metadata: true });

    expect(seenUrl).toContain("metadata=1");
    expect(items[0].metadata).toEqual({ path: "/settings", state: "before" });
  });

  it("omits the param when metadata is not requested", async () => {
    let seenUrl = "";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ files: [], cursor: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
    });

    await client.listAll({ prefix: "gh/" });

    expect(seenUrl).not.toContain("metadata");
  });
});
