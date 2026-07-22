import { describe, expect, it, vi, afterEach } from "vitest";
import { app } from "../index";
import { POSITIVE_CACHE_CONTROL } from "../github-avatars";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /public/github/avatars/:owner", () => {
  it("400s on invalid owner without calling GitHub", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request("https://api.uploads.sh/public/github/avatars/-bad");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proxies a valid owner avatar from GitHub", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/buildinternet.png") {
          return new Response(PNG, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const res = await app.request("https://api.uploads.sh/public/github/avatars/BuildInternet");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(POSITIVE_CACHE_CONTROL);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("returns 404 when GitHub has no such user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const res = await app.request("https://api.uploads.sh/public/github/avatars/no-such-user-zzz");
    expect(res.status).toBe(404);
  });
});
