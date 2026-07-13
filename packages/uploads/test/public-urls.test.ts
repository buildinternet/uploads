import { afterEach, describe, expect, it } from "vitest";
import {
  embedUrlFromPublic,
  resolveEmbedBaseUrl,
  resolveEmbedUrl,
  urlForGithubEmbed,
} from "../src/public-urls.js";

describe("public-urls / embed", () => {
  afterEach(() => {
    delete process.env.UPLOADS_EMBED_PUBLIC_BASE_URL;
  });

  it("rewrites storage.uploads.sh to embed by default", () => {
    expect(embedUrlFromPublic("https://storage.uploads.sh/default/gh/o/r/pull/1/a.webp")).toBe(
      "https://embed.uploads.sh/default/gh/o/r/pull/1/a.webp",
    );
  });

  it("honors UPLOADS_EMBED_PUBLIC_BASE_URL", () => {
    process.env.UPLOADS_EMBED_PUBLIC_BASE_URL = "https://embed.example.com";
    expect(
      resolveEmbedUrl("https://cdn.example.com/ws/a.png", null, {
        publicBaseUrl: "https://cdn.example.com",
        embedBaseUrl: process.env.UPLOADS_EMBED_PUBLIC_BASE_URL,
      }),
    ).toBe("https://embed.example.com/ws/a.png");
  });

  it("disables with empty UPLOADS_EMBED_PUBLIC_BASE_URL", () => {
    expect(
      embedUrlFromPublic("https://storage.uploads.sh/default/a.png", {
        publicBaseUrl: "https://storage.uploads.sh",
        embedBaseUrl: "",
      }),
    ).toBeNull();
  });

  it("prefers API embedUrl when provided", () => {
    expect(
      resolveEmbedUrl(
        "https://storage.uploads.sh/default/a.png",
        "https://embed.uploads.sh/default/a.png",
      ),
    ).toBe("https://embed.uploads.sh/default/a.png");
  });

  it("urlForGithubEmbed falls back to stable url", () => {
    expect(urlForGithubEmbed("https://cdn.byo.test/x.png", null)).toBe(
      "https://cdn.byo.test/x.png",
    );
  });

  it("resolveEmbedBaseUrl defaults only for known hosts", () => {
    expect(resolveEmbedBaseUrl("https://storage.uploads.sh")).toBe("https://embed.uploads.sh");
    expect(resolveEmbedBaseUrl("https://other.test")).toBeNull();
  });
});
