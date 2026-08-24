/**
 * Per-workspace read limiter (issue #829 §3): tier classification, keying,
 * and the 429 contract (body `retry_after` plus the `Retry-After` /
 * `X-Retry-After` header pair).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "./error-response";
import {
  classifyLegacyListingRead,
  classifyListingRead,
  heavyReadRateLimit,
  listingIsHydrated,
  listingReadRateLimit,
  legacyListingReadRateLimit,
  readRateLimit,
  READ_LIMIT_WINDOW_SECONDS,
} from "./read-limits";
import type { WorkspaceVars } from "./workspace";

/** Records every key it is asked about; `allow` decides the verdict. */
function fakeLimiter(allow: boolean) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: allow };
      },
    },
  };
}

/**
 * Minimal router that mounts one of the read limiters behind a stand-in for
 * the auth middleware that normally sets `workspaceName`.
 */
function harness(middleware: MiddlewareHandler<WorkspaceVars>, workspace = "acme") {
  return new Hono<WorkspaceVars>()
    .use("*", async (c, next) => {
      c.set("workspaceName", workspace);
      await next();
    })
    .get("/probe", middleware, (c) => c.json({ ok: true }))
    .onError((err, c) => respondError(c, err));
}

describe("read tier classification", () => {
  it("treats a canonical listing as hydrated unless the caller opts out", () => {
    expect(listingIsHydrated(undefined)).toBe(true);
    expect(listingIsHydrated("1")).toBe(true);
    expect(listingIsHydrated("0")).toBe(false);
    expect(listingIsHydrated("false")).toBe(false);
  });

  it("charges a hydrated listing the tight tier and an unhydrated one the normal tier", () => {
    expect(classifyListingRead(undefined)).toBe("tight");
    expect(classifyListingRead("0")).toBe("normal");
    expect(classifyListingRead("false")).toBe("normal");
  });

  it("classifies the legacy listing by its own inverted metadata contract", () => {
    // Bare prefix list: object storage only.
    expect(classifyLegacyListingRead({})).toBe("normal");
    expect(classifyLegacyListingRead({ prefix: "f/" })).toBe("normal");
    // Opt-in hydration, and the two shapes that switch to the D1 search path.
    expect(classifyLegacyListingRead({ metadata: "1" })).toBe("tight");
    expect(classifyLegacyListingRead({ name: "shot" })).toBe("tight");
    expect(classifyLegacyListingRead({ "meta.path": "web/home" })).toBe("tight");
  });
});

describe("read limiter keying", () => {
  it("keys the normal limiter by workspace", async () => {
    const limiter = fakeLimiter(true);
    const res = await harness(readRateLimit, "acme").request("/probe", {}, {
      READ_LIMITER: limiter.binding,
    } as never);
    expect(res.status).toBe(200);
    expect(limiter.keys).toEqual(["acme"]);
  });

  it("keys the tight limiter by workspace and never spends the normal budget", async () => {
    const normal = fakeLimiter(true);
    const tight = fakeLimiter(true);
    const res = await harness(heavyReadRateLimit, "beta").request("/probe", {}, {
      READ_LIMITER: normal.binding,
      HEAVY_READ_LIMITER: tight.binding,
    } as never);
    expect(res.status).toBe(200);
    expect(tight.keys).toEqual(["beta"]);
    expect(normal.keys).toEqual([]);
  });

  it("gives each workspace its own bucket", async () => {
    const limiter = fakeLimiter(true);
    const env = { HEAVY_READ_LIMITER: limiter.binding } as never;
    await harness(heavyReadRateLimit, "acme").request("/probe", {}, env);
    await harness(heavyReadRateLimit, "beta").request("/probe", {}, env);
    expect(limiter.keys).toEqual(["acme", "beta"]);
  });

  it("fails open when the binding is absent", async () => {
    const res = await harness(heavyReadRateLimit).request("/probe", {}, {} as never);
    expect(res.status).toBe(200);
  });

  it("leaves the write limiter untouched", async () => {
    const write = fakeLimiter(false);
    const res = await harness(heavyReadRateLimit).request("/probe", {}, {
      WRITE_LIMITER: write.binding,
      HEAVY_READ_LIMITER: fakeLimiter(true).binding,
    } as never);
    expect(res.status).toBe(200);
    expect(write.keys).toEqual([]);
  });
});

describe("hydrated vs metadata=0 listing routing", () => {
  it("charges a hydrated listing to the tight limiter", async () => {
    const normal = fakeLimiter(true);
    const tight = fakeLimiter(true);
    const env = { READ_LIMITER: normal.binding, HEAVY_READ_LIMITER: tight.binding } as never;
    await harness(listingReadRateLimit).request("/probe", {}, env);
    expect(tight.keys).toEqual(["acme"]);
    expect(normal.keys).toEqual([]);
  });

  it("charges a `metadata=0` listing to the normal limiter", async () => {
    const normal = fakeLimiter(true);
    const tight = fakeLimiter(true);
    const env = { READ_LIMITER: normal.binding, HEAVY_READ_LIMITER: tight.binding } as never;
    await harness(listingReadRateLimit).request("/probe?metadata=0", {}, env);
    expect(normal.keys).toEqual(["acme"]);
    expect(tight.keys).toEqual([]);
  });

  it("still serves a `metadata=0` listing when only the tight limiter is exhausted", async () => {
    const env = {
      READ_LIMITER: fakeLimiter(true).binding,
      HEAVY_READ_LIMITER: fakeLimiter(false).binding,
    } as never;
    const res = await harness(listingReadRateLimit).request("/probe?metadata=0", {}, env);
    expect(res.status).toBe(200);
  });

  it("routes the legacy listing by its own contract", async () => {
    const normal = fakeLimiter(true);
    const tight = fakeLimiter(true);
    const env = { READ_LIMITER: normal.binding, HEAVY_READ_LIMITER: tight.binding } as never;
    await harness(legacyListingReadRateLimit).request("/probe", {}, env);
    await harness(legacyListingReadRateLimit).request("/probe?metadata=1", {}, env);
    expect(normal.keys).toEqual(["acme"]);
    expect(tight.keys).toEqual(["acme"]);
  });
});

describe("429 contract", () => {
  it("returns a rate_limited envelope with retry_after and both headers", async () => {
    const res = await harness(heavyReadRateLimit).request("/probe", {}, {
      HEAVY_READ_LIMITER: fakeLimiter(false).binding,
    } as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(READ_LIMIT_WINDOW_SECONDS));
    // Compat spelling the shipped client also reads (packages/uploads).
    expect(res.headers.get("X-Retry-After")).toBe(String(READ_LIMIT_WINDOW_SECONDS));
    const body = (await res.json()) as {
      error: { type: string; code: string; details?: { retry_after?: number } };
    };
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.code).toBe("read_rate_limited");
    expect(body.error.details?.retry_after).toBe(READ_LIMIT_WINDOW_SECONDS);
  });

  it("emits no ratelimit limit/remaining/reset headers", async () => {
    // A Cloudflare `RateLimit` binding reports only `{ success }`, so there is
    // no accurate quota or reset instant to publish. Asserted so a future
    // change has to decide deliberately rather than fabricate numbers.
    const res = await harness(heavyReadRateLimit).request("/probe", {}, {
      HEAVY_READ_LIMITER: fakeLimiter(false).binding,
    } as never);
    for (const header of [
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "RateLimit",
    ]) {
      expect(res.headers.get(header)).toBeNull();
    }
  });

  it("emits no retry headers for an error that carries no figure", async () => {
    const app = new Hono()
      .get("/boom", () => {
        throw new Error("nope");
      })
      .onError((err, c) => respondError(c, err));
    const res = await app.request("/boom", {}, {} as never);
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("X-Retry-After")).toBeNull();
  });
});
