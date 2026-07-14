import { describe, expect, it } from "vitest";
import { deriveCookieDomain, isCliSessionUserAgent } from "./auth";

describe("isCliSessionUserAgent", () => {
  it("matches the uploads CLI device-flow User-Agent", () => {
    expect(isCliSessionUserAgent("@buildinternet/uploads/1.2.3 (device-token)")).toBe(true);
    expect(isCliSessionUserAgent("@buildinternet/uploads")).toBe(true);
  });

  it("rejects browsers and empty values", () => {
    expect(isCliSessionUserAgent("Mozilla/5.0 (Macintosh) Chrome/120")).toBe(false);
    expect(isCliSessionUserAgent(null)).toBe(false);
    expect(isCliSessionUserAgent(undefined)).toBe(false);
  });
});

describe("deriveCookieDomain", () => {
  it("shares the whole apex host for a 2-label domain (no public-suffix leak)", () => {
    expect(deriveCookieDomain("https://uploads.sh")).toBe(".uploads.sh");
  });

  it("strips the first label for a 3+-label host", () => {
    expect(deriveCookieDomain("https://auth.uploads.sh")).toBe(".uploads.sh");
    expect(deriveCookieDomain("https://api.auth.uploads.sh")).toBe(".auth.uploads.sh");
  });

  it("returns undefined for localhost", () => {
    expect(deriveCookieDomain("http://localhost:8788")).toBeUndefined();
  });

  it("returns undefined for a *.localhost host", () => {
    expect(deriveCookieDomain("http://auth.localhost:8788")).toBeUndefined();
  });

  it("returns undefined for an IP host", () => {
    expect(deriveCookieDomain("http://127.0.0.1:8788")).toBeUndefined();
  });

  it("returns undefined for an invalid URL", () => {
    expect(deriveCookieDomain("not-a-url")).toBeUndefined();
  });

  it("returns undefined when the URL is undefined", () => {
    expect(deriveCookieDomain(undefined)).toBeUndefined();
  });
});
