import { describe, expect, it, vi } from "vitest";
import { UploadsError } from "../src/errors.js";
import {
  assertFetchableUploadUrl,
  FETCH_UPLOAD_SOURCE_MAX_REDIRECTS,
  fetchUploadSource,
  filenameFromUploadUrl,
  resolveUploadFilename,
} from "../src/fetch-upload-source.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MAX = 1024;

function pngResponse(init: ResponseInit = {}): Response {
  return new Response(PNG, { status: 200, ...init });
}

describe("assertFetchableUploadUrl", () => {
  it("accepts a public https URL", () => {
    expect(assertFetchableUploadUrl("https://cdn.example/shot.png").hostname).toBe("cdn.example");
  });

  it("rejects a non-absolute URL", () => {
    expect(() => assertFetchableUploadUrl("/shot.png")).toThrow(UploadsError);
  });

  it("rejects http", () => {
    expect(() => assertFetchableUploadUrl("http://cdn.example/shot.png", "--url")).toThrow(
      /--url must be https/,
    );
  });

  it("rejects URL credentials", () => {
    expect(() => assertFetchableUploadUrl("https://user:pass@cdn.example/shot.png")).toThrow(
      /must not include credentials/,
    );
  });

  it.each([
    "https://localhost/shot.png",
    "https://127.0.0.1/shot.png",
    "https://10.0.0.5/shot.png",
    "https://192.168.1.1/shot.png",
    "https://169.254.169.254/latest",
    "https://foo.internal/shot.png",
    "https://[::1]/shot.png",
  ])("rejects a private/internal host: %s", (url) => {
    expect(() => assertFetchableUploadUrl(url)).toThrow(/private or internal/);
  });

  it.each([
    "http://localhost/shot.png",
    "http://127.0.0.1:4321/shot.png",
    "http://app.localhost/shot.png",
    "https://localhost/shot.png",
    "http://[::1]/shot.png",
  ])("accepts loopback when allowLoopback is set: %s", (url) => {
    expect(assertFetchableUploadUrl(url, "--url", { allowLoopback: true }).href).toBe(
      new URL(url).href,
    );
  });

  it("still rejects LAN and link-local when allowLoopback is set", () => {
    expect(() =>
      assertFetchableUploadUrl("https://10.0.0.5/shot.png", "--url", { allowLoopback: true }),
    ).toThrow(/private or internal/);
    expect(() =>
      assertFetchableUploadUrl("http://169.254.169.254/latest", "--url", { allowLoopback: true }),
    ).toThrow(/must be https/);
    expect(() =>
      assertFetchableUploadUrl("http://cdn.example/shot.png", "--url", { allowLoopback: true }),
    ).toThrow(/must be https/);
  });
});

describe("filenameFromUploadUrl", () => {
  it("takes the path leaf", () => {
    expect(filenameFromUploadUrl(new URL("https://cdn.example/a/shot.png?x=1"))).toBe("shot.png");
  });

  it("returns undefined when there is no leaf", () => {
    expect(filenameFromUploadUrl(new URL("https://cdn.example/"))).toBeUndefined();
  });
});

describe("resolveUploadFilename", () => {
  it("prefers an explicit filename", () => {
    expect(resolveUploadFilename("https://cdn.example/id", "hero.png")).toBe("hero.png");
  });

  it("derives the path leaf when filename is omitted", () => {
    expect(resolveUploadFilename("https://cdn.example/a/shot.png?x=1", undefined)).toBe("shot.png");
  });

  it("throws USAGE when the URL has no path leaf", () => {
    expect(() => resolveUploadFilename("https://cdn.example/", undefined, "--url")).toThrow(
      /--url has no filename in the path/,
    );
  });
});

describe("fetchUploadSource", () => {
  it("returns the body of a 200", async () => {
    const doFetch = vi.fn(async () => pngResponse());
    const bytes = await fetchUploadSource("https://cdn.example/shot.png", {
      maxBytes: MAX,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(bytes).toEqual(PNG);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({ "user-agent": "uploads.sh" }),
      }),
    );
  });

  it("follows a public https redirect and re-validates the hop", async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://files.example/shot.png" },
        }),
      )
      .mockResolvedValueOnce(pngResponse());
    const bytes = await fetchUploadSource("https://cdn.example/shot.png", {
      maxBytes: MAX,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(bytes).toEqual(PNG);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(String(doFetch.mock.calls[1]![0])).toBe("https://files.example/shot.png");
  });

  it("resolves a relative Location against the current URL", async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/files/shot.png" } }),
      )
      .mockResolvedValueOnce(pngResponse());
    await fetchUploadSource("https://cdn.example/old.png", {
      maxBytes: MAX,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(String(doFetch.mock.calls[1]![0])).toBe("https://cdn.example/files/shot.png");
  });

  it("refuses a redirect onto a private host without fetching it", async () => {
    const doFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/secret" },
      });
    });
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/private or internal/);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches http loopback when allowLoopback is set", async () => {
    const doFetch = vi.fn(async () => pngResponse());
    const bytes = await fetchUploadSource("http://127.0.0.1:4321/shot.png", {
      maxBytes: MAX,
      allowLoopback: true,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(bytes).toEqual(PNG);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("does not let a public origin redirect onto loopback even with allowLoopback", async () => {
    const doFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    });
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        allowLoopback: true,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/must be https|private or internal/);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("follows a loopback-to-loopback redirect when allowLoopback is set", async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:4321/shot.png" },
        }),
      )
      .mockResolvedValueOnce(pngResponse());
    const bytes = await fetchUploadSource("http://localhost:4321/old.png", {
      maxBytes: MAX,
      allowLoopback: true,
      fetch: doFetch as unknown as typeof fetch,
    });
    expect(bytes).toEqual(PNG);
    expect(String(doFetch.mock.calls[1]![0])).toBe("http://127.0.0.1:4321/shot.png");
  });

  it("caps redirect hops", async () => {
    const doFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      return new Response(null, {
        status: 302,
        headers: { location: `${url}?n=${Math.random()}` },
      });
    });
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/redirected too many times/);
    expect(doFetch).toHaveBeenCalledTimes(FETCH_UPLOAD_SOURCE_MAX_REDIRECTS + 1);
  });

  it("rejects a non-200 without reading a body", async () => {
    const doFetch = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        label: "contentUrl",
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/could not fetch contentUrl \(HTTP 404\)/);
  });

  it("rejects Content-Length over the cap before buffering", async () => {
    const doFetch = vi.fn(async () => {
      return new Response(PNG, {
        status: 200,
        headers: { "content-length": String(MAX + 1) },
      });
    });
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(UploadsError);
  });

  it("rejects a streamed body that exceeds the cap", async () => {
    const big = new Uint8Array(MAX + 8).fill(1);
    const doFetch = vi.fn(async () => new Response(big, { status: 200 }));
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(UploadsError);
  });

  it("rejects an empty 200", async () => {
    const doFetch = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/empty body/);
  });

  it("maps a network failure to NETWORK", async () => {
    const doFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fetchUploadSource("https://cdn.example/shot.png", {
        maxBytes: MAX,
        label: "contentUrl",
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: "could not fetch contentUrl", code: "NETWORK" });
  });
});
