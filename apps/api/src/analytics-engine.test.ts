import { describe, expect, it } from "vitest";
import { breakdownQuery, fetchBreakdown } from "./analytics-engine";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: "acct-123",
    ANALYTICS_API_TOKEN: "tok-abc",
    ...overrides,
  } as unknown as Env;
}

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("breakdownQuery", () => {
  it("selects the blob matching the requested dimension", () => {
    expect(breakdownQuery("surface", 30)).toContain("blob2");
    expect(breakdownQuery("repo", 30)).toContain("blob6");
  });

  it("multiplies by _sample_interval so sampled counts are scaled back up", () => {
    expect(breakdownQuery("surface", 30)).toContain("_sample_interval");
  });

  it("windows by the requested number of days", () => {
    expect(breakdownQuery("surface", 7)).toContain("INTERVAL '7' DAY");
  });
});

describe("fetchBreakdown", () => {
  it("returns rows on success", async () => {
    const impl = jsonFetch({
      data: [
        { value: "api", events: 120, bytes: 5000 },
        { value: "mcp", events: 40, bytes: 900 },
      ],
    });
    const result = await fetchBreakdown(env(), "surface", 30, impl);
    expect(result).toEqual({
      available: true,
      rows: [
        { value: "api", events: 120, bytes: 5000 },
        { value: "mcp", events: 40, bytes: 900 },
      ],
    });
  });

  it("reports unavailable when the token is missing", async () => {
    const result = await fetchBreakdown(
      env({ ANALYTICS_API_TOKEN: undefined }),
      "surface",
      30,
      jsonFetch({}),
    );
    expect(result).toEqual({ available: false, reason: "not_configured" });
  });

  it("reports unavailable when the account id is missing", async () => {
    const result = await fetchBreakdown(
      env({ CLOUDFLARE_ACCOUNT_ID: undefined }),
      "surface",
      30,
      jsonFetch({}),
    );
    expect(result).toEqual({ available: false, reason: "not_configured" });
  });

  it("reports unavailable on a non-OK response rather than throwing", async () => {
    const result = await fetchBreakdown(env(), "surface", 30, jsonFetch({ errors: ["nope"] }, 403));
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("reports unavailable when the request throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchBreakdown(env(), "surface", 30, impl);
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("rejects an unknown dimension without issuing a request", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await fetchBreakdown(env(), "bogus" as never, 30, impl);
    expect(result).toEqual({ available: false, reason: "invalid_dimension" });
    expect(called).toBe(false);
  });

  it.each(["toString", "constructor", "__proto__"] as const)(
    "rejects the inherited prototype key %j without issuing a request",
    async (dimension) => {
      let called = false;
      const impl = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const result = await fetchBreakdown(env(), dimension as never, 30, impl);
      expect(result).toEqual({ available: false, reason: "invalid_dimension" });
      expect(called).toBe(false);
    },
  );

  it("reports unavailable when the response body's data field is not an array", async () => {
    const result = await fetchBreakdown(env(), "surface", 30, jsonFetch({ data: "not-an-array" }));
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });
});

describe("breakdownQuery non-finite days guard", () => {
  it("falls back to a 30-day window when days is NaN", () => {
    expect(breakdownQuery("surface", Number.NaN)).toContain("INTERVAL '30' DAY");
  });

  it("falls back to a 30-day window when days is Infinity", () => {
    expect(breakdownQuery("surface", Number.POSITIVE_INFINITY)).toContain("INTERVAL '30' DAY");
  });
});
