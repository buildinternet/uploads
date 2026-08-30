import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

describe("GET /internal/metrics", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  function app() {
    return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
  }

  function env(): AuthEnv {
    return {
      DB: db,
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    } as AuthEnv;
  }

  async function seedUser(createdAt: Date, overrides: Partial<schema.AuthUser> = {}) {
    await orm.insert(schema.user).values({
      id: crypto.randomUUID(),
      name: "Ada",
      email: `ada-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      image: null,
      createdAt,
      updatedAt: createdAt,
      role: overrides.role ?? "user",
      banned: overrides.banned ?? null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
      notifyMemberJoin: true,
      notifyUsageLimits: true,
    } as schema.AuthUser);
  }

  it("groups signups by UTC day", async () => {
    await seedUser(new Date("2026-07-26T10:00:00Z"));
    await seedUser(new Date("2026-07-28T01:00:00Z"));
    await seedUser(new Date("2026-07-28T23:00:00Z"));

    const res = await app().request("/internal/metrics?since=2026-07-01", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { day: string; count: number }[] };
    expect(body.users).toEqual([
      { day: "2026-07-26", count: 1 },
      { day: "2026-07-28", count: 2 },
    ]);
  });

  it("excludes signups before the window", async () => {
    await seedUser(new Date("2026-07-01T10:00:00Z"));
    await seedUser(new Date("2026-07-28T10:00:00Z"));

    const res = await app().request("/internal/metrics?since=2026-07-20", {}, env());
    const body = (await res.json()) as { users: { day: string; count: number }[] };
    expect(body.users).toEqual([{ day: "2026-07-28", count: 1 }]);
  });

  it("reports all-time totals independent of the window", async () => {
    // role/banned overrides still exercise seedUser's full column set even
    // though totals.admins/totals.banned were removed (Fix 6: nothing ever
    // read them — MetricsOverview.totals has no such fields and the page
    // renders neither — so those two unwindowed full-table scans were
    // wasted work on every cache miss).
    await seedUser(new Date("2026-01-01T10:00:00Z"), { role: "admin" });
    await seedUser(new Date("2026-07-28T10:00:00Z"), { banned: true });

    const res = await app().request("/internal/metrics?since=2026-07-20", {}, env());
    const body = (await res.json()) as {
      totals: { users: number };
    };
    expect(body.totals.users).toBe(2);
    expect((body.totals as Record<string, unknown>).admins).toBeUndefined();
    expect((body.totals as Record<string, unknown>).banned).toBeUndefined();
  });

  it("defaults to a 30-day window when `since` is absent", async () => {
    const res = await app().request("/internal/metrics", {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; orgs: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
    expect(Array.isArray(body.orgs)).toBe(true);
  });

  it("rejects a malformed `since`", async () => {
    const res = await app().request("/internal/metrics?since=not-a-date", {}, env());
    expect(res.status).toBe(400);
  });

  it("rejects a digit-shaped but out-of-range `since` (month 13, day 45)", async () => {
    const res = await app().request("/internal/metrics?since=2026-13-45", {}, env());
    expect(res.status).toBe(400);
  });

  it("rejects a digit-shaped but non-existent calendar date (Feb 30)", async () => {
    const res = await app().request("/internal/metrics?since=2026-02-30", {}, env());
    expect(res.status).toBe(400);
  });
});
