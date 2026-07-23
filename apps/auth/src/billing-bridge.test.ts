/**
 * Stripe phase 2, task 4: syncWorkspacePlan — see src/billing-bridge.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";
import { syncWorkspacePlan } from "./billing-bridge";
import { createFakeD1 } from "./test/fake-d1";

type TestEnv = AuthEnv & Pick<Env, "API" | "BILLING_INTERNAL_KEY">;

function dbEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

async function seedOrganization(env: TestEnv, slug: string): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const id = crypto.randomUUID();
  await orm.insert(schema.organization).values({
    id,
    name: slug,
    slug,
    createdAt: new Date(),
  });
  return id;
}

describe("syncWorkspacePlan", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("resolves org id to slug and POSTs the plan-set contract to env.API", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orgId = await seedOrganization(env, "acme");
    const orm = drizzle(env.DB, { schema });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm, orgId, "pro");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/internal/billing/plan");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-internal-billing-key"]).toBe(
      "shh-its-secret",
    );
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "acme", plan: "pro" });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("no-ops with a log for an unknown organization id", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orm = drizzle(env.DB, { schema });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm, crypto.randomUUID(), "free");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs and swallows a non-2xx response", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orgId = await seedOrganization(env, "acme");
    const orm = drizzle(env.DB, { schema });
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await expect(syncWorkspacePlan(env, orm, orgId, "pro")).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs and swallows a thrown fetch", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orgId = await seedOrganization(env, "acme");
    const orm = drizzle(env.DB, { schema });
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await expect(syncWorkspacePlan(env, orm, orgId, "free")).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops with a log when env.API is missing", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orgId = await seedOrganization(env, "acme");
    const orm = drizzle(env.DB, { schema });

    await syncWorkspacePlan(env, orm, orgId, "pro");

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops with a log when BILLING_INTERNAL_KEY is missing", async () => {
    const env = dbEnv();
    const orgId = await seedOrganization(env, "acme");
    const orm = drizzle(env.DB, { schema });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    await syncWorkspacePlan(env, orm, orgId, "free");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves (never rejects) and logs when the org-slug lookup itself throws", async () => {
    const env = dbEnv({ BILLING_INTERNAL_KEY: "shh-its-secret" });
    const orgId = await seedOrganization(env, "acme");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    env.API = { fetch: fetchMock } as unknown as Fetcher;

    const brokenOrm = {
      select: () => {
        throw new Error("D1 is down");
      },
    } as unknown as ReturnType<typeof drizzle<typeof schema>>;

    await expect(syncWorkspacePlan(env, brokenOrm, orgId, "pro")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    // Two logs, not one: the sync failure, then the outbox enqueue failing on
    // the same broken db. The queue lives in D1, so it cannot survive D1
    // itself being down — see billing-outbox.ts. Still resolves either way,
    // which is the property this test exists to pin.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });
});
