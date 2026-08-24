import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { createAuth, isCliSessionUserAgent, upsertGithubLogin, type AuthEnv } from "./auth";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

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

// Issue #580: captured via the github socialProvider's mapProfileToUser hook
// (see src/auth.ts), which runs on every completed GitHub OAuth callback —
// this exercises just the upsert itself, not the wiring through Better Auth.
describe("upsertGithubLogin", () => {
  function orm() {
    return drizzle(createFakeD1(), { schema });
  }

  it("inserts a new row for a first-time link", async () => {
    const db = orm();
    await upsertGithubLogin(db, "123", "octocat");
    const rows = await db.select().from(schema.githubIdentity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "123", login: "octocat" });
  });

  it("last-write-wins: a re-authentication with a renamed login overwrites the stored value", async () => {
    const db = orm();
    await upsertGithubLogin(db, "123", "octocat");
    await upsertGithubLogin(db, "123", "octocat-renamed");
    const rows = await db.select().from(schema.githubIdentity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "123", login: "octocat-renamed" });
  });

  it("never throws — swallows a write failure (e.g. blank inputs are no-ops)", async () => {
    const db = orm();
    await expect(upsertGithubLogin(db, "", "octocat")).resolves.toBeUndefined();
    await expect(upsertGithubLogin(db, "123", "")).resolves.toBeUndefined();
    expect(await db.select().from(schema.githubIdentity)).toHaveLength(0);
  });
});

// Rate-limit storage selection (2026-08-23 incident follow-up). The point of
// these two: production must get the Durable-Object customStorage, and every
// binding-less caller (tests, bare local envs) must still build without one.
describe("rateLimit storage selection", () => {
  function env(overrides: Partial<AuthEnv> = {}): AuthEnv {
    return {
      DB: createFakeD1(),
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "https://uploads.sh",
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "production",
      ...overrides,
    };
  }

  it("uses the Durable-Object customStorage when RATE_LIMIT is bound", async () => {
    const RATE_LIMIT = {
      idFromName: (name: string) => name,
      get: () => ({ consume: async () => ({ allowed: true, retryAfter: null }) }),
    };
    const auth = await createAuth(env({ RATE_LIMIT }));
    const rateLimit = auth?.options.rateLimit;
    expect(rateLimit?.enabled).toBe(true);
    expect(typeof rateLimit?.customStorage?.consume).toBe("function");
    expect(rateLimit?.storage).toBeUndefined();
  });

  it("falls back to Better Auth's memory storage when the binding is absent", async () => {
    const auth = await createAuth(env({ AUTH_RATE_LIMIT_DISABLED: "true" }));
    const rateLimit = auth?.options.rateLimit;
    expect(rateLimit?.customStorage).toBeUndefined();
    expect(rateLimit?.storage).toBe("memory");
  });
});

// End-to-end through Better Auth's own limiter, using a customStorage that
// denies EVERYTHING. Anything that still answers non-429 is genuinely exempt.
describe("rate limiting exemptions (live handler)", () => {
  function denyAllEnv(): AuthEnv {
    return {
      DB: createFakeD1(),
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "https://uploads.sh",
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "production",
      RATE_LIMIT: {
        idFromName: (name: string) => name,
        get: () => ({ consume: async () => ({ allowed: false, retryAfter: 30 }) }),
      },
    };
  }

  it("never 429s a burst of /get-session — the path is exempt (customRules false)", async () => {
    const auth = await createAuth(denyAllEnv());
    expect(auth).toBeTruthy();
    for (let i = 0; i < 10; i++) {
      const res = await auth!.handler(
        new Request("https://uploads.sh/api/auth/get-session", {
          headers: { "cf-connecting-ip": "203.0.113.7" },
        }),
      );
      expect(res.status).not.toBe(429);
    }
  });

  it("still 429s a limited path, proving the deny-all storage is wired in", async () => {
    const auth = await createAuth(denyAllEnv());
    const res = await auth!.handler(
      new Request("https://uploads.sh/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ email: "someone@example.com" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Retry-After")).toBe("30");
  });
});
