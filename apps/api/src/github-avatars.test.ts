import { describe, expect, it, vi } from "vitest";
import {
  NEGATIVE_CACHE_CONTROL,
  POSITIVE_CACHE_CONTROL,
  githubAvatarProxyUrl,
  normalizeGithubOwner,
  ownerFromRepo,
  resolveGithubAvatar,
  type AvatarCache,
} from "./github-avatars";

describe("normalizeGithubOwner", () => {
  it("accepts common logins and lowercases", () => {
    expect(normalizeGithubOwner("buildinternet")).toBe("buildinternet");
    expect(normalizeGithubOwner("BuildInternet")).toBe("buildinternet");
    expect(normalizeGithubOwner("acme-corp")).toBe("acme-corp");
  });

  it("rejects invalid logins", () => {
    expect(normalizeGithubOwner("")).toBeNull();
    expect(normalizeGithubOwner("-acme")).toBeNull();
    expect(normalizeGithubOwner("acme-")).toBeNull();
    expect(normalizeGithubOwner("has space")).toBeNull();
    expect(normalizeGithubOwner("x".repeat(40))).toBeNull();
  });
});

describe("ownerFromRepo", () => {
  it("parses owner/name", () => {
    expect(ownerFromRepo("buildinternet/uploads")).toBe("buildinternet");
    expect(ownerFromRepo("BuildInternet/Uploads")).toBe("buildinternet");
  });

  it("rejects malformed repos", () => {
    expect(ownerFromRepo("noshslash")).toBeNull();
    expect(ownerFromRepo("/uploads")).toBeNull();
    expect(ownerFromRepo("a/b/c")).toBeNull();
  });
});

describe("githubAvatarProxyUrl", () => {
  it("builds the public proxy URL", () => {
    expect(githubAvatarProxyUrl("https://api.uploads.sh/", "acme")).toBe(
      "https://api.uploads.sh/public/github/avatars/acme",
    );
  });
});

function memoryCache(): AvatarCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response.clone());
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("resolveGithubAvatar", () => {
  const cacheKeyUrl = "https://api.uploads.sh/public/github/avatars/buildinternet";

  it("returns the upstream image and caches a positive hit", async () => {
    const cache = memoryCache();
    const fetchImpl = vi.fn(
      async () =>
        new Response(PNG, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );

    const first = await resolveGithubAvatar("buildinternet", {
      cacheKeyUrl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe(POSITIVE_CACHE_CONTROL);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await resolveGithubAvatar("buildinternet", {
      cacheKeyUrl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a 404 from upstream", async () => {
    const cache = memoryCache();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const key = "https://api.uploads.sh/public/github/avatars/missing-org";

    const first = await resolveGithubAvatar("missing-org", {
      cacheKeyUrl: key,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(first.status).toBe(404);
    expect(first.headers.get("Cache-Control")).toBe(NEGATIVE_CACHE_CONTROL);

    await resolveGithubAvatar("missing-org", {
      cacheKeyUrl: key,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-image content types", async () => {
    const res = await resolveGithubAvatar("buildinternet", {
      cacheKeyUrl,
      fetchImpl: vi.fn(
        async () =>
          new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      ) as unknown as typeof fetch,
      cache: null,
    });
    expect(res.status).toBe(502);
  });

  it("returns 502 when upstream fetch throws", async () => {
    const res = await resolveGithubAvatar("buildinternet", {
      cacheKeyUrl,
      fetchImpl: vi.fn(async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
      cache: null,
    });
    expect(res.status).toBe(502);
  });
});
