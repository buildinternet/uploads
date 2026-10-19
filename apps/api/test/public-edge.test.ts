import { describe, expect, it, vi } from "vitest";
import edge, { type PublicEdgeEnv } from "../src/public-edge";

function setup(rollout = "all") {
  const api = vi.fn(async () => new Response("api"));
  const viewer = vi.fn(async () => new Response("viewer"));
  const env: PublicEdgeEnv = {
    API: { fetch: api } as unknown as Fetcher,
    PUBLIC_VIEWER: { fetch: viewer } as unknown as Fetcher,
    PUBLIC_VIEWER_ROLLOUT: rollout,
  };
  return { api, viewer, env };
}

describe("public edge dispatcher", () => {
  it.each([
    "/public/files/acme/screenshots/a%20b%2Fc.png?download=1",
    "/public/files/acme/a%252Fb.png?download=true",
    "/public/files/acme/a.png",
    "/public/galleries/gallery/items/item/download",
    "/public/galleries/gallery",
    "/public/feeds/feed?cursor=abc%2Fdef",
    "/public/feeds/feed/items/item",
  ])("passes the original request and streaming response through for %s", async (path) => {
    const { api, viewer, env } = setup();
    const request = new Request(`https://api.uploads.sh${path}`, {
      headers: { Range: "bytes=0-3", Cookie: "session=example" },
    });
    const response = new Response(new Uint8Array([0, 255, 13, 10]), {
      status: 206,
      headers: {
        "Content-Disposition": "attachment; filename=a.png",
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Range": "bytes 0-3/4",
      },
    });
    viewer.mockResolvedValue(response);
    expect(await edge.fetch(request, env)).toBe(response);
    expect(viewer).toHaveBeenCalledExactlyOnceWith(request);
    expect(api).not.toHaveBeenCalled();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 13, 10]);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=a.png");
  });

  it("routes HEAD and files-only rollout without changing the request", async () => {
    const { api, viewer, env } = setup("files");
    const request = new Request("https://api.uploads.sh/public/files/ws/a.png?download=1", {
      method: "HEAD",
    });
    await edge.fetch(request, env);
    expect(viewer).toHaveBeenCalledExactlyOnceWith(request);
    await edge.fetch(
      new Request("https://api.uploads.sh/public/galleries/g/items/i/download"),
      env,
    );
    expect(api).toHaveBeenCalledOnce();
  });

  it.each(["off", "unknown", ""])("falls back to API for rollout %s", async (rollout) => {
    const { api, viewer, env } = setup(rollout);
    await edge.fetch(
      new Request("https://api.uploads.sh/public/files/ws/a.png?download=true"),
      env,
    );
    expect(api).toHaveBeenCalledOnce();
    expect(viewer).not.toHaveBeenCalled();
  });

  it("falls back when the viewer binding is absent", async () => {
    const { api, env } = setup();
    delete env.PUBLIC_VIEWER;
    await edge.fetch(new Request("https://api.uploads.sh/public/files/ws/a.png"), env);
    expect(api).toHaveBeenCalledOnce();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("keeps %s on API", async (method) => {
    const { api, viewer, env } = setup();
    const request = new Request("https://api.uploads.sh/public/files/ws/a.png", { method });
    await edge.fetch(request, env);
    expect(api).toHaveBeenCalledExactlyOnceWith(request);
    expect(viewer).not.toHaveBeenCalled();
  });

  it.each([
    "/public/github/avatars/owner",
    "/public/files/ws",
    "/public/galleries/g/unknown",
    "/public/feeds/f/items/i/unknown",
    "/v1/workspaces/ws/files/a.png",
    "/health",
  ])("keeps unknown or private path %s on API", async (path) => {
    const { api, viewer, env } = setup();
    await edge.fetch(new Request(`https://api.uploads.sh${path}`), env);
    expect(api).toHaveBeenCalledOnce();
    expect(viewer).not.toHaveBeenCalled();
  });

  it("does not retry an error response on API", async () => {
    const { api, viewer, env } = setup();
    const response = new Response("unavailable", { status: 503, headers: { "Retry-After": "2" } });
    viewer.mockResolvedValue(response);
    expect(await edge.fetch(new Request("https://api.uploads.sh/public/files/ws/a.png"), env)).toBe(
      response,
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("does not retry a rejected viewer fetch on API", async () => {
    const { api, viewer, env } = setup();
    const error = new Error("binding unavailable");
    viewer.mockRejectedValue(error);
    await expect(
      edge.fetch(new Request("https://api.uploads.sh/public/files/ws/a.png"), env),
    ).rejects.toBe(error);
    expect(api).not.toHaveBeenCalled();
  });
});
