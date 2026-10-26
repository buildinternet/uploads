import { describe, expect, it } from "vitest";
import { thumbUrl } from "./thumb-url";

describe("thumbUrl", () => {
  it("rewrites embed.uploads.sh URLs to a same-origin cdn-cgi transform", () => {
    expect(thumbUrl("https://embed.uploads.sh/default/shots/home.png", 560)).toBe(
      "https://embed.uploads.sh/cdn-cgi/image/width=560,quality=82,fit=scale-down,format=auto,onerror=redirect/default/shots/home.png",
    );
  });

  it("rewrites storage.uploads.sh and store.uploads.sh hosts too", () => {
    expect(thumbUrl("https://storage.uploads.sh/ws/a.webp", 64)).toBe(
      "https://storage.uploads.sh/cdn-cgi/image/width=64,quality=82,fit=scale-down,format=auto,onerror=redirect/ws/a.webp",
    );
    expect(thumbUrl("https://store.uploads.sh/ws/a.webp", 64)).toBe(
      "https://store.uploads.sh/cdn-cgi/image/width=64,quality=82,fit=scale-down,format=auto,onerror=redirect/ws/a.webp",
    );
  });

  it("preserves query strings (capability URLs keep their params)", () => {
    expect(thumbUrl("https://embed.uploads.sh/gh/private/abc/x.png?sig=123", 560)).toBe(
      "https://embed.uploads.sh/cdn-cgi/image/width=560,quality=82,fit=scale-down,format=auto,onerror=redirect/gh/private/abc/x.png?sig=123",
    );
  });

  it("passes through hosts outside the uploads.sh transform zone", () => {
    const byo = "https://cdn.example.com/ws/a.png";
    expect(thumbUrl(byo, 560)).toBe(byo);
  });

  it("passes through SVGs untouched", () => {
    const svg = "https://embed.uploads.sh/ws/logo.svg";
    expect(thumbUrl(svg, 560)).toBe(svg);
  });

  it("does not double-wrap an already transformed URL", () => {
    const wrapped =
      "https://embed.uploads.sh/cdn-cgi/image/width=64,quality=82,fit=scale-down,format=auto,onerror=redirect/ws/a.png";
    expect(thumbUrl(wrapped, 560)).toBe(wrapped);
  });

  it("passes through null and unparseable input", () => {
    expect(thumbUrl(null, 560)).toBeNull();
    expect(thumbUrl("not a url", 560)).toBe("not a url");
  });

  it("accepts an explicit jpeg or png format and still redirects on error", () => {
    expect(thumbUrl("https://storage.uploads.sh/ws/a.jpg", 1200, { format: "jpeg" })).toBe(
      "https://storage.uploads.sh/cdn-cgi/image/width=1200,quality=82,fit=scale-down,format=jpeg,onerror=redirect/ws/a.jpg",
    );
    expect(thumbUrl("https://storage.uploads.sh/ws/a.png", 1200, { format: "png" })).toBe(
      "https://storage.uploads.sh/cdn-cgi/image/width=1200,quality=82,fit=scale-down,format=png,onerror=redirect/ws/a.png",
    );
  });
});
