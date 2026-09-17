import { describe, expect, it, vi } from "vitest";
import { jwksFetcherFor } from "../src/oauth";

const JWKS = { keys: [{ kid: "k1", kty: "RSA", use: "sig", alg: "RS256", n: "x", e: "AQAB" }] };
const jwksResponse = () =>
  new Response(JSON.stringify(JWKS), { headers: { "content-type": "application/json" } });

describe("jwksFetcherFor", () => {
  it("fetches the JWKS over the AUTH binding, rewritten to the internal origin", async () => {
    const bindingFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jwksResponse(),
    );
    const fetcher = jwksFetcherFor({ AUTH: { fetch: bindingFetch } as unknown as Fetcher });

    const jwks = await fetcher("https://uploads.sh/api/auth/jwks");

    expect(jwks).toEqual(JWKS);
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    // Path preserved, host swapped to the internal alias so the binding routes
    // straight to uploads-auth rather than the web /api/auth proxy.
    expect(String(bindingFetch.mock.calls[0][0])).toBe("https://auth.internal/api/auth/jwks");
  });

  it("falls back to global fetch against the public JWKS URL when no AUTH binding", async () => {
    const globalFetch = vi.fn(async (_input: RequestInfo | URL) => jwksResponse());
    vi.stubGlobal("fetch", globalFetch);
    try {
      const fetcher = jwksFetcherFor({});
      const jwks = await fetcher("https://uploads.sh/api/auth/jwks");

      expect(jwks).toEqual(JWKS);
      expect(String(globalFetch.mock.calls[0][0])).toBe("https://uploads.sh/api/auth/jwks");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a non-ok or malformed JWKS response", async () => {
    const notOk = jwksFetcherFor({
      AUTH: { fetch: async () => new Response("nope", { status: 503 }) } as unknown as Fetcher,
    });
    await expect(notOk("https://uploads.sh/api/auth/jwks")).rejects.toThrow(/jwks fetch failed/);

    const malformed = jwksFetcherFor({
      AUTH: {
        fetch: async () => new Response(JSON.stringify({ nope: true })),
      } as unknown as Fetcher,
    });
    await expect(malformed("https://uploads.sh/api/auth/jwks")).rejects.toThrow(/malformed jwks/);
  });
});
