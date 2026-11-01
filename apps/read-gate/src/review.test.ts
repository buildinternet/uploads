import { describe, expect, it, vi } from "vitest";
import { handleReadGate, transformOptions, type ReadGateEnv } from "./index";
import { MAX_REVIEW_TTL_SECONDS, signReview, verifyReview } from "./review";

const SECRET = "test-review-secret";
const KEY = "acme/env.png";

function blockedEnv() {
  const calls: string[] = [];
  const env = {
    READ_GATE_REVIEW_SECRET: SECRET,
    DB: {
      prepare(sql: string) {
        calls.push(sql);
        return { bind: () => ({ first: async () => ({ hit: 1 }) }) };
      },
    },
  } as unknown as ReadGateEnv;
  return { env, calls };
}

const ctx = { waitUntil() {} };
const now = () => Math.floor(Date.now() / 1000);

describe("verifyReview", () => {
  it("accepts its own signature and nothing else", async () => {
    const exp = now() + 600;
    const token = await signReview(SECRET, "hosted", KEY, exp);
    expect(await verifyReview(SECRET, token, "hosted", KEY, now())).toBe(true);
    expect(await verifyReview(SECRET, token, "hosted", "acme/other.png", now())).toBe(false);
    expect(await verifyReview("other", token, "hosted", KEY, now())).toBe(false);
    expect(await verifyReview(undefined, token, "hosted", KEY, now())).toBe(false);
    const bumped = token.replace(/^\d+/, String(exp + 60));
    expect(await verifyReview(SECRET, bumped, "hosted", KEY, now())).toBe(false);
    expect(await verifyReview(SECRET, "garbage", "hosted", KEY, now())).toBe(false);
  });

  it("refuses an expired link and one that claims too long a life", async () => {
    const past = await signReview(SECRET, "hosted", KEY, now() - 1);
    expect(await verifyReview(SECRET, past, "hosted", KEY, now())).toBe(false);
    const long = await signReview(SECRET, "hosted", KEY, now() + MAX_REVIEW_TTL_SECONDS + 60);
    expect(await verifyReview(SECRET, long, "hosted", KEY, now())).toBe(false);
  });
});

describe("signReview", () => {
  it("matches the API's signature for the same inputs", async () => {
    // Same vector as apps/api/test/read-gate-review.test.ts.
    expect(await signReview(SECRET, "hosted", KEY, 2000000000)).toBe(
      "2000000000.vsAVaBdd36gpC1-CnmloBXYD4t8j1RUqeOOZ8Zx8JdA",
    );
  });
});

describe("transformOptions", () => {
  it("reads the resizer options and ignores the rest", () => {
    expect(
      transformOptions(
        "/cdn-cgi/image/width=360,fit=scale-down,format=jpeg,quality=70,x=1/a/b.png",
      ),
    ).toEqual({ width: 360, fit: "scale-down", format: "jpeg", quality: 70 });
    expect(transformOptions("/acme/b.png")).toBeNull();
  });
});

describe("reviewer links", () => {
  it("serves a held key's bytes with no-store and no D1 lookup", async () => {
    const origin = vi.fn(
      async () =>
        new Response("bytes", {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=60" },
        }),
    );
    vi.stubGlobal("fetch", origin);
    const { env, calls } = blockedEnv();
    const token = await signReview(SECRET, "hosted", KEY, now() + 600);
    const response = await handleReadGate(
      new Request(`https://storage.uploads.sh/${KEY}?review=${token}`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("runs a signed transform on the signed source URL", async () => {
    const origin = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("jpeg"),
    );
    vi.stubGlobal("fetch", origin);
    const { env } = blockedEnv();
    const token = await signReview(SECRET, "hosted", KEY, now() + 600);
    const response = await handleReadGate(
      new Request(
        `https://storage.uploads.sh/cdn-cgi/image/width=360,format=jpeg/${KEY}?review=${token}`,
      ),
      env,
      ctx,
    );
    expect(await response.text()).toBe("jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, init] = origin.mock.calls[0]!;
    expect(url).toBe(`https://storage.uploads.sh/${KEY}?review=${encodeURIComponent(token)}`);
    expect((init as { cf?: unknown }).cf).toEqual({ image: { width: 360, format: "jpeg" } });
    vi.unstubAllGlobals();
  });

  it("falls back to the gate on a bad or expired link", async () => {
    const origin = vi.fn(async () => new Response("bytes"));
    vi.stubGlobal("fetch", origin);
    const { env, calls } = blockedEnv();
    const other = await signReview(SECRET, "hosted", "acme/other.png", now() + 600);
    const expired = await signReview(SECRET, "hosted", KEY, now() - 5);
    for (const token of [other, expired, "1.abc"]) {
      const response = await handleReadGate(
        new Request(`https://storage.uploads.sh/${KEY}?review=${token}`),
        env,
        ctx,
      );
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(await response.text()).not.toBe("bytes");
    }
    expect(origin).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("lets no link through when the secret is unset", async () => {
    const origin = vi.fn(async () => new Response("bytes"));
    vi.stubGlobal("fetch", origin);
    const { env } = blockedEnv();
    delete (env as { READ_GATE_REVIEW_SECRET?: string }).READ_GATE_REVIEW_SECRET;
    const token = await signReview(SECRET, "hosted", KEY, now() + 600);
    const response = await handleReadGate(
      new Request(`https://storage.uploads.sh/${KEY}?review=${token}`),
      env,
      ctx,
    );
    expect(origin).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    vi.unstubAllGlobals();
  });
});
