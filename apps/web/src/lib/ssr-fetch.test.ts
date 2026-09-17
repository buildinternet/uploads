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
