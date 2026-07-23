/**
 * Durable retry for the billing plan bridge (issue #451) — see
 * src/billing-outbox.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";
import {
  MAX_ATTEMPTS,
  backoffSeconds,
  desiredPlanFor,
  enqueuePlanSync,
  runPlanSyncOutbox,
} from "./billing-outbox";
import { syncWorkspacePlan } from "./billing-bridge";
import { createFakeD1 } from "./test/fake-d1";

type TestEnv = AuthEnv & Pick<Env, "API" | "BILLING_INTERNAL_KEY">;

const NOW = new Date("2026-07-23T12:00:00.000Z");

function dbEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    BILLING_INTERNAL_KEY: "shh-its-secret",
    ...overrides,
  };
}

function orm(env: TestEnv) {
  return drizzle(env.DB, { schema });
}

async function seedOrganization(env: TestEnv, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await orm(env).insert(schema.organization).values({ id, name: slug, slug, createdAt: NOW });
  return id;
}

async function seedSubscription(env: TestEnv, referenceId: string, status: string) {
  await orm(env)
    .insert(schema.subscription)
    .values({ id: crypto.randomUUID(), plan: "pro", referenceId, status });
}

async function outboxRows(env: TestEnv) {
  return orm(env).select().from(schema.billingPlanOutbox);
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 204 }));
}

describe("backoffSeconds", () => {
  it("doubles from a minute and caps at an hour", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(99)).toBe(3600);
  });

  it("gives a total retry window of just over 24 hours", () => {
    // Pins the number MAX_ATTEMPTS' doc comment claims, so tuning either the
    // cap or the curve can't silently leave that comment wrong: the initial
    // wait after enqueue, plus one wait per failed attempt up to the cap.
    let total = backoffSeconds(1);
    for (let attempts = 1; attempts < MAX_ATTEMPTS; attempts += 1) {
      total += backoffSeconds(attempts);
    }
    expect(total).toBe(86_640);
    expect(total / 3600).toBeGreaterThan(24);
  });
});

describe("desiredPlanFor", () => {
  it("is free with no subscription row at all", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    expect(await desiredPlanFor(orm(env), orgId)).toBe("free");
  });

  it.each(["active", "trialing", "past_due"])("is pro while status is %s", async (status) => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await seedSubscription(env, orgId, status);
    expect(await desiredPlanFor(orm(env), orgId)).toBe("pro");
  });

  it.each(["canceled", "incomplete_expired", "unpaid"])(
    "is free once status is %s",
    async (status) => {
      const env = dbEnv();
      const orgId = await seedOrganization(env, "acme");
      await seedSubscription(env, orgId, status);
      expect(await desiredPlanFor(orm(env), orgId)).toBe("free");
    },
  );
});

describe("enqueuePlanSync", () => {
  it("queues one row per organization and resets attempts on requeue", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");

    await enqueuePlanSync(orm(env), orgId, "first failure", NOW);
    await orm(env)
      .update(schema.billingPlanOutbox)
      .set({ attempts: 5 })
      .where(eq(schema.billingPlanOutbox.referenceId, orgId));
    await enqueuePlanSync(orm(env), orgId, "second failure", NOW);

    const rows = await outboxRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].lastError).toBe("second failure");
  });
});

describe("syncWorkspacePlan enqueues on failure", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it("queues the org when apps/api rejects the plan set", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    env.API = {
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
    } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm(env), orgId, "pro");

    const rows = await outboxRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].referenceId).toBe(orgId);
    expect(rows[0].lastError).toBe("status 500");
  });

  it("queues the org when the service binding throws", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    env.API = {
      fetch: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm(env), orgId, "pro");

    const rows = await outboxRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastError).toBe("boom");
  });

  it("queues the org when BILLING_INTERNAL_KEY is missing", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: undefined });
    const orgId = await seedOrganization(env, "acme");
    env.API = { fetch: okFetch() } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm(env), orgId, "pro");

    expect(await outboxRows(env)).toHaveLength(1);
  });

  it("queues nothing on a successful sync", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    env.API = { fetch: okFetch() } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm(env), orgId, "pro");

    expect(await outboxRows(env)).toHaveLength(0);
  });
});

describe("runPlanSyncOutbox", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it("re-posts the plan and clears the row on success", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await seedSubscription(env, orgId, "active");
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);

    const fetchMock = okFetch();
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    const result = await runPlanSyncOutbox(env, orm(env), new Date(NOW.getTime() + 120_000));

    expect(result).toEqual({ attempted: 1, synced: 1, rescheduled: 0, exhausted: 0 });
    expect(await outboxRows(env)).toHaveLength(0);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "acme", plan: "pro" });
  });

  it("recomputes the plan at retry time rather than replaying the queued one", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await seedSubscription(env, orgId, "active");
    // Queued while the subscription was active...
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);
    // ...and canceled before the drain ran.
    await orm(env)
      .update(schema.subscription)
      .set({ status: "canceled" })
      .where(eq(schema.subscription.referenceId, orgId));

    const fetchMock = okFetch();
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await runPlanSyncOutbox(env, orm(env), new Date(NOW.getTime() + 120_000));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "acme", plan: "free" });
  });

  it("leaves rows that aren't due yet alone", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);

    const fetchMock = okFetch();
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    const result = await runPlanSyncOutbox(env, orm(env), NOW);

    expect(result.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await outboxRows(env)).toHaveLength(1);
  });

  it("reschedules with a longer backoff when the retry fails again", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);
    env.API = {
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    } as unknown as Fetcher;

    const drainAt = new Date(NOW.getTime() + 120_000);
    const result = await runPlanSyncOutbox(env, orm(env), drainAt);

    expect(result).toEqual({ attempted: 1, synced: 0, rescheduled: 1, exhausted: 0 });
    const [row] = await outboxRows(env);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("status 503");
    expect(row.nextAttemptAt.getTime()).toBe(drainAt.getTime() + backoffSeconds(1) * 1000);
  });

  it("stops retrying at the attempt cap", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);
    await orm(env)
      .update(schema.billingPlanOutbox)
      .set({ attempts: MAX_ATTEMPTS - 1 })
      .where(eq(schema.billingPlanOutbox.referenceId, orgId));

    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;
    const drainAt = new Date(NOW.getTime() + 120_000);

    const first = await runPlanSyncOutbox(env, orm(env), drainAt);
    expect(first).toEqual({ attempted: 1, synced: 0, rescheduled: 0, exhausted: 1 });

    // A later pass must not pick the exhausted row back up.
    const second = await runPlanSyncOutbox(env, orm(env), new Date(drainAt.getTime() + 86_400_000));
    expect(second.attempted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await outboxRows(env)).toHaveLength(1);
  });

  it("isn't starved by a backlog of exhausted rows", async () => {
    // Exhausted rows keep a nextAttemptAt in the past forever, so they sort to
    // the front of the due query. A batch's worth of them must not crowd out a
    // row that genuinely needs retrying.
    const env = dbEnv();
    const orm_ = orm(env);
    for (let i = 0; i < 60; i += 1) {
      await enqueuePlanSync(orm_, `exhausted-${i}`, "status 500", new Date(0));
      await orm_
        .update(schema.billingPlanOutbox)
        .set({ attempts: MAX_ATTEMPTS })
        .where(eq(schema.billingPlanOutbox.referenceId, `exhausted-${i}`));
    }

    const orgId = await seedOrganization(env, "acme");
    await seedSubscription(env, orgId, "active");
    await enqueuePlanSync(orm_, orgId, "status 500", NOW);

    const fetchMock = okFetch();
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    const result = await runPlanSyncOutbox(env, orm_, new Date(NOW.getTime() + 120_000));

    expect(result.synced).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "acme", plan: "pro" });
  });

  it("drops a row whose organization no longer exists", async () => {
    const env = dbEnv();
    await enqueuePlanSync(orm(env), "org-that-vanished", "status 500", NOW);
    const fetchMock = okFetch();
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    const result = await runPlanSyncOutbox(env, orm(env), new Date(NOW.getTime() + 120_000));

    expect(result.attempted).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await outboxRows(env)).toHaveLength(0);
  });

  it("skips the pass without touching rows when the bindings are absent", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: undefined });
    const orgId = await seedOrganization(env, "acme");
    await enqueuePlanSync(orm(env), orgId, "status 500", NOW);
    env.API = { fetch: okFetch() } as unknown as Fetcher;

    const result = await runPlanSyncOutbox(env, orm(env), new Date(NOW.getTime() + 120_000));

    expect(result.attempted).toBe(0);
    expect(await outboxRows(env)).toHaveLength(1);
  });
});
