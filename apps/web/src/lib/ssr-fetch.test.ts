import { describe, expect, it, vi } from "vitest";
import { publicApiFetch, SSR_USER_AGENT } from "./ssr-fetch";

describe("SSR_USER_AGENT", () => {
  it("identifies the web worker so empty-UA WAF rules let SSR calls through", () => {
    expect(SSR_USER_AGENT).toMatch(/uploads-web/);
    expect(SSR_USER_AGENT.length).toBeGreaterThan(0);
  });
});

describe("publicApiFetch", () => {
  it("routes through the API service binding when present (bypassing the public edge)", async () => {
    const bindingFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    const env = { API: { fetch: bindingFetch } as unknown as Fetcher };

    const fetchImpl = publicApiFetch(env);
    await fetchImpl("https://api.uploads.sh/public/files/acme/x.png", { cache: "no-store" });

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(String(bindingFetch.mock.calls[0][0])).toBe(
      "https://api.uploads.sh/public/files/acme/x.png",
    );
  });

  it("falls back to global fetch when the binding is absent (astro dev)", () => {
    expect(publicApiFetch({})).toBe(globalThis.fetch);
    expect(publicApiFetch({ API: undefined })).toBe(globalThis.fetch);
  });
});

describe("public viewer rollout", () => {
  function setup(rollout = "all") {
    const response = new Response("download bytes", {
      status: 200,
      headers: {
        "Content-Disposition": 'attachment; filename="shot.png"',
        "Cache-Control": "no-store",
      },
    });
    const viewerFetch = vi.fn(async () => response);
    const apiFetch = vi.fn(async () => new Response("api"));
    const env = {
      PUBLIC_VIEWER: { fetch: viewerFetch } as unknown as Fetcher,
      API: { fetch: apiFetch } as unknown as Fetcher,
      PUBLIC_VIEWER_ROLLOUT: rollout,
    };
    return { env, viewerFetch, apiFetch, response };
  }

  it.each([
    "/public/files/acme/f/My%20Shot%23.png?download=1",
    "/public/feeds/feed-id?cursor=opaque_123",
    "/public/feeds/feed-id/items/item-id",
    "/public/galleries/gallery-id",
    "/public/galleries/gallery-id/items/item-id/download",
  ])("forwards enabled public reads unchanged: %s", async (path) => {
    const { env, viewerFetch, apiFetch, response } = setup();
    const url = `https://api.uploads.sh${path}`;
    const init = { cache: "no-store" as const, headers: { "User-Agent": SSR_USER_AGENT } };
    const result = await publicApiFetch(env)(url, init);
    expect(viewerFetch).toHaveBeenCalledWith(url, init);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result).toBe(response);
    expect(result.headers.get("Content-Disposition")).toContain("attachment");
    expect(await result.text()).toBe("download bytes");
  });

  it("limits the initial rollout to files, including Request inputs and HEAD", async () => {
    const { env, viewerFetch, apiFetch } = setup("files");
    const request = new Request("https://api.uploads.sh/public/files/acme/x.png", {
      method: "HEAD",
    });
    await publicApiFetch(env)(request);
    expect(viewerFetch).toHaveBeenCalledWith(request, undefined);
    await publicApiFetch(env)("https://api.uploads.sh/public/feeds/id");
    await publicApiFetch(env)("https://api.uploads.sh/public/galleries/id");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["off", "", "unknown"])("uses API when rollout is %j", async (rollout) => {
    const { env, viewerFetch, apiFetch } = setup(rollout);
    await publicApiFetch(env)("https://api.uploads.sh/public/files/acme/x.png");
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(viewerFetch).not.toHaveBeenCalled();
  });

  it("keeps authenticated paths, unknown routes, and writes on API", async () => {
    const { env, viewerFetch, apiFetch } = setup();
    const fetchImpl = publicApiFetch(env);
    await fetchImpl("https://api.uploads.sh/me");
    await fetchImpl("https://api.uploads.sh/v1/acme/files/x.png", { method: "DELETE" });
    await fetchImpl("https://api.uploads.sh/public/files/acme/x.png", { method: "POST" });
    await fetchImpl("https://api.uploads.sh/public/other/x");
    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(viewerFetch).not.toHaveBeenCalled();
  });

  it("retains HTTP fallback and never retries viewer errors through another worker", async () => {
    expect(publicApiFetch({ PUBLIC_VIEWER_ROLLOUT: "all" })).toBe(globalThis.fetch);
    const { env, viewerFetch, apiFetch } = setup();
    viewerFetch.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      publicApiFetch(env)("https://api.uploads.sh/public/files/acme/x.png"),
    ).rejects.toThrow("unavailable");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
