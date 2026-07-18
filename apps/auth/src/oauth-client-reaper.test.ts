import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { sweepOauthClients } from "./oauth-client-reaper";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

let db: FakeD1Database;
let env: AuthEnv;

beforeEach(() => {
  db = createFakeD1();
  env = { DB: db, WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
});

function seedClient(
  id: string,
  overrides: Partial<{
    clientId: string;
    createdAt: Date;
    userId: string | null;
    skipConsent: boolean | null;
    metadata: Record<string, unknown> | null;
  }> = {},
) {
  return drizzle(db, { schema })
    .insert(schema.oauthClient)
    .values({
      id,
      clientId: overrides.clientId ?? `client-${id}`,
      redirectUris: ["https://client.example.com/callback"],
      scopes: ["files:read"],
      userId: overrides.userId ?? null,
      skipConsent: overrides.skipConsent ?? null,
      metadata: overrides.metadata ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.createdAt ?? new Date(),
    });
}

describe("sweepOauthClients", () => {
  it("observes (does not delete) stale anonymous unused clients by default", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await seedClient("stale-1", { createdAt: old });

    const result = await sweepOauthClients(env);

    expect(result.mode).toBe("observe");
    expect(result.candidates).toBe(1);
    expect(result.reapable).toBe(1);
    expect(result.deleted).toBe(0);

    // Issue #251 seeds a recent, non-stale "uploads-cli" oauth_client row via
    // migration, so a clean DB has that row plus stale-1.
    const remaining = await drizzle(db, { schema }).select().from(schema.oauthClient);
    expect(remaining).toHaveLength(2);
  });

  it("deletes stale anonymous unused clients when OAUTH_CLIENT_REAPER_ENABLED=true", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await seedClient("stale-1", { createdAt: old });

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.mode).toBe("delete");
    expect(result.deleted).toBe(1);

    // The seeded "uploads-cli" row (issue #251) is recent and survives the sweep.
    const remaining = await drizzle(db, { schema }).select().from(schema.oauthClient);
    expect(remaining).toHaveLength(1);
  });

  it("never sweeps a recent client, a session-owned client, or a trusted (skip_consent) client", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    await seedClient("recent", { createdAt: recent });
    await seedClient("owned", { createdAt: old, userId: "user-1" });
    await seedClient("trusted", { createdAt: old, skipConsent: true });

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.candidates).toBe(0);
    expect(result.deleted).toBe(0);

    // Plus the seeded "uploads-cli" row (issue #251), which is also recent.
    const remaining = await drizzle(db, { schema }).select().from(schema.oauthClient);
    expect(remaining).toHaveLength(4);
  });

  it("never sweeps a client with a consent row, even if stale and anonymous", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await seedClient("consented", { createdAt: old });
    await drizzle(db, { schema })
      .insert(schema.oauthConsent)
      .values({
        id: "consent-1",
        userId: "user-1",
        clientId: "client-consented",
        scopes: ["files:read"],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.candidates).toBe(1);
    expect(result.reapable).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("never sweeps a stale seeded uploads-cli client (issue #251 skip_consent exemption)", async () => {
    // The migration seeds "uploads-cli" as skip_consent=1 specifically so a
    // stale-but-never-consented row (device-flow logins never create
    // oauth_consent/oauth_access_token rows) isn't reaped. Backdate the
    // seeded row's created_at past the cutoff and confirm it's excluded.
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await drizzle(db, { schema })
      .update(schema.oauthClient)
      .set({ createdAt: old, updatedAt: old })
      .where(eq(schema.oauthClient.clientId, "uploads-cli"));

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.candidates).toBe(0);
    expect(result.reapable).toBe(0);
    expect(result.deleted).toBe(0);

    const remaining = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, "uploads-cli"));
    expect(remaining).toHaveLength(1);
  });

  it("never sweeps a stale, never-used, official operator-panel client (metadata.official)", async () => {
    // internal-routes.ts's client-create route seeds panel-created official
    // clients with userId: null + skipConsent: false — identical to an
    // anonymous DCR registration except for the metadata.official flag. That
    // flag must be checked in both the listing AND the delete predicate, or
    // an official client that goes unused past retention gets silently
    // hard-deleted.
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await seedClient("official-1", { createdAt: old, metadata: { official: true } });

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.candidates).toBe(0);
    expect(result.reapable).toBe(0);
    expect(result.deleted).toBe(0);

    const remaining = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, "client-official-1"));
    expect(remaining).toHaveLength(1);
  });

  it("still reaps a comparable non-official client with the same shape", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await seedClient("non-official-1", { createdAt: old, metadata: null });

    const result = await sweepOauthClients({ ...env, OAUTH_CLIENT_REAPER_ENABLED: "true" });

    expect(result.deleted).toBe(1);
    const remaining = await drizzle(db, { schema })
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, "client-non-official-1"));
    expect(remaining).toHaveLength(0);
  });
});
