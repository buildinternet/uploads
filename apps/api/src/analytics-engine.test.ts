import { describe, expect, it } from "vitest";
import { breakdownQuery, fetchBreakdown, fetchSlowOps, slowOpsQuery } from "./analytics-engine";

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

  // Fix 1/2 (structural blob-ordinal contract): BLOB_COLUMN is now DERIVED
  // from adoption.ts's BLOB_ORDER rather than a hand-synced literal. This
  // locks in the exact mapping the derivation must produce — byte-identical
  // to the pre-derivation hand-listed version, minus `plan` (Fix 2 drops it
  // from the queryable BreakdownDimension type since no caller ever sets it,
  // while its blob5 slot stays reserved in BLOB_ORDER so `repo` keeps blob6).
  it("derives every queryable dimension's blob column from BLOB_ORDER", () => {
    expect(breakdownQuery("surface", 30)).toContain("blob2");
    expect(breakdownQuery("contentType", 30)).toContain("blob3");
    expect(breakdownQuery("client", 30)).toContain("blob4");
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

  // Fix 2: `plan` reserves a blob slot (see adoption.ts's BLOB_ORDER) but is
  // no longer a queryable BreakdownDimension — nothing sets it, so it would
  // only ever return a single always-empty row. Confirm it is now rejected
  // the same way any other unknown dimension is, rather than silently
  // returning that dead data.
  it("rejects the reserved-but-unpopulated `plan` dimension without issuing a request", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await fetchBreakdown(env(), "plan" as never, 30, impl);
    expect(result).toEqual({ available: false, reason: "invalid_dimension" });
    expect(called).toBe(false);
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

describe("slowOpsQuery", () => {
  it("windows 24h as a 24-hour interval and 7d as a 168-hour interval", () => {
    expect(slowOpsQuery("24h")).toContain("INTERVAL '24' HOUR");
    expect(slowOpsQuery("7d")).toContain("INTERVAL '168' HOUR");
  });

  it("groups by op (blob1) and computes p50/p95 wall ms from double1", () => {
    const sql = slowOpsQuery("24h");
    expect(sql).toContain("blob1 AS op");
    expect(sql).toContain("quantile(0.5)(double1) AS p50WallMs");
    expect(sql).toContain("quantile(0.95)(double1) AS p95WallMs");
    expect(sql).toContain("GROUP BY op");
  });

  it("scales the count by _sample_interval like breakdownQuery", () => {
    expect(slowOpsQuery("24h")).toContain("_sample_interval");
  });
});

describe("fetchSlowOps", () => {
  it("returns rows on success", async () => {
    const impl = jsonFetch({
      data: [{ op: "d1", count: 12, p50WallMs: 1200, p95WallMs: 4500 }],
    });
    const result = await fetchSlowOps(env(), "24h", impl);
    expect(result).toEqual({
      available: true,
      rows: [{ op: "d1", count: 12, p50WallMs: 1200, p95WallMs: 4500 }],
    });
  });

  it("reports unavailable when the token is missing", async () => {
    const result = await fetchSlowOps(
      env({ ANALYTICS_API_TOKEN: undefined }),
      "24h",
      jsonFetch({}),
    );
    expect(result).toEqual({ available: false, reason: "not_configured" });
  });

  it("reports unavailable on a non-OK response rather than throwing", async () => {
    const result = await fetchSlowOps(env(), "24h", jsonFetch({ errors: ["nope"] }, 403));
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("reports unavailable when the request throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchSlowOps(env(), "24h", impl);
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });

  it("reports unavailable when the response body's data field is not an array", async () => {
    const result = await fetchSlowOps(env(), "24h", jsonFetch({ data: "not-an-array" }));
    expect(result).toEqual({ available: false, reason: "query_failed" });
  });
});
