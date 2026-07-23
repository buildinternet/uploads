/**
 * Stripe phase 2, task 5: stripePluginOrNone — see src/stripe-plugin.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";
import { desiredPlanForStatus, isOrgBillingAdmin, stripePluginOrNone } from "./stripe-plugin";
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

const BOTH_SECRETS = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
};

describe("stripePluginOrNone", () => {
  it("returns [] when STRIPE_SECRET_KEY is missing", () => {
    const env = dbEnv({ STRIPE_WEBHOOK_SECRET: "whsec_123" });
    const db = drizzle(env.DB, { schema });
    expect(stripePluginOrNone(env, db)).toEqual([]);
  });

  it("returns [] when STRIPE_WEBHOOK_SECRET is missing", () => {
    const env = dbEnv({ STRIPE_SECRET_KEY: "sk_test_123" });
    const db = drizzle(env.DB, { schema });
    expect(stripePluginOrNone(env, db)).toEqual([]);
  });

  it("returns [] when both secrets are missing", () => {
    const env = dbEnv();
    const db = drizzle(env.DB, { schema });
    expect(stripePluginOrNone(env, db)).toEqual([]);
  });

  it("returns exactly one plugin when both secrets are present", () => {
    const env = dbEnv({ ...BOTH_SECRETS });
    const db = drizzle(env.DB, { schema });
    const plugins = stripePluginOrNone(env, db);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe("stripe");
  });
});

describe("desiredPlanForStatus", () => {
  it("keeps pro for active and trialing", () => {
    expect(desiredPlanForStatus("active")).toBe("pro");
    expect(desiredPlanForStatus("trialing")).toBe("pro");
  });

  it("downgrades to free for every other status", () => {
    for (const status of [
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "paused",
      "unpaid",
    ]) {
      expect(desiredPlanForStatus(status)).toBe("free");
    }
  });
});

describe("isOrgBillingAdmin", () => {
  async function seed(env: TestEnv) {
    const db = drizzle(env.DB, { schema });
    const orgId = crypto.randomUUID();
    await db.insert(schema.organization).values({
      id: orgId,
      name: "acme",
      slug: "acme",
      createdAt: new Date(),
    });

    async function seedUser(role: "owner" | "admin" | "member") {
      const userId = crypto.randomUUID();
      await db.insert(schema.user).values({
        id: userId,
        name: role,
        email: `${role}@example.com`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: orgId,
        userId,
        role,
        createdAt: new Date(),
      });
      return userId;
    }

    return { db, orgId, seedUser };
  }

  it("is true for an owner", async () => {
    const env = dbEnv();
    const { db, orgId, seedUser } = await seed(env);
    const userId = await seedUser("owner");
    expect(await isOrgBillingAdmin(db, userId, orgId)).toBe(true);
  });

  it("is true for an admin", async () => {
    const env = dbEnv();
    const { db, orgId, seedUser } = await seed(env);
    const userId = await seedUser("admin");
    expect(await isOrgBillingAdmin(db, userId, orgId)).toBe(true);
  });

  it("is false for a plain member", async () => {
    const env = dbEnv();
    const { db, orgId, seedUser } = await seed(env);
    const userId = await seedUser("member");
    expect(await isOrgBillingAdmin(db, userId, orgId)).toBe(false);
  });

  it("is false for a non-member", async () => {
    const env = dbEnv();
    const { db, orgId } = await seed(env);
    expect(await isOrgBillingAdmin(db, crypto.randomUUID(), orgId)).toBe(false);
  });
});
