import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { runAuthRetentionSweep } from "./retention-sweep";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

let db: FakeD1Database;
let env: AuthEnv;

beforeEach(() => {
  db = createFakeD1();
  env = { DB: db, WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
});

function seedVerification(id: string, expiresAt: Date) {
  return drizzle(db, { schema })
    .insert(schema.verification)
    .values({
      id,
      identifier: `${id}@example.com`,
      value: "token",
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

function seedDeviceCode(id: string, expiresAt: Date) {
  return drizzle(db, { schema })
    .insert(schema.deviceCode)
    .values({
      id,
      deviceCode: `dc-${id}`,
      userCode: `uc-${id}`,
      expiresAt,
      status: "pending",
    });
}

function seedClientAssertion(id: string, expiresAt: Date) {
  return drizzle(db, { schema }).insert(schema.oauthClientAssertion).values({ id, expiresAt });
}

async function seedInvitation(id: string, expiresAt: Date, status = "pending") {
  const dz = drizzle(db, { schema });
  const now = new Date();
  await dz
    .insert(schema.user)
    .values({
      id: `inviter-${id}`,
      name: "Inviter",
      email: `inviter-${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await dz
    .insert(schema.organization)
    .values({ id: "org-1", name: "Acme", slug: "acme", createdAt: now })
    .onConflictDoNothing();
  await dz.insert(schema.invitation).values({
    id,
    organizationId: "org-1",
    email: `${id}@example.com`,
    role: "member",
    status,
    expiresAt,
    inviterId: `inviter-${id}`,
    createdAt: now,
  });
}

describe("runAuthRetentionSweep", () => {
  it("deletes expired verification and device_code rows, keeps unexpired ones", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await seedVerification("expired-1", past);
    await seedVerification("expired-2", past);
    await seedVerification("live-1", future);

    await seedDeviceCode("expired-1", past);
    await seedDeviceCode("live-1", future);

    await seedClientAssertion("jti-expired-1", past);
    await seedClientAssertion("jti-expired-2", past);
    await seedClientAssertion("jti-live-1", future);

    const result = await runAuthRetentionSweep(env);

    expect(result).toEqual({
      verificationDeleted: 2,
      deviceCodeDeleted: 1,
      clientAssertionDeleted: 2,
      invitationDeleted: 0,
    });

    const dz = drizzle(db, { schema });
    const remainingVerification = await dz.select().from(schema.verification);
    const remainingDeviceCode = await dz.select().from(schema.deviceCode);

    expect(remainingVerification.map((r) => r.id)).toEqual(["live-1"]);
    expect(remainingDeviceCode.map((r) => r.id)).toEqual(["live-1"]);
    // A live jti must survive: deleting it early would reopen replay.
    const remainingAssertions = await dz.select().from(schema.oauthClientAssertion);
    expect(remainingAssertions.map((r) => r.id)).toEqual(["jti-live-1"]);
  });

  it("is a no-op when nothing is expired", async () => {
    const future = new Date(Date.now() + 60_000);
    await seedVerification("live-1", future);
    await seedDeviceCode("live-1", future);

    const result = await runAuthRetentionSweep(env);

    expect(result).toEqual({
      verificationDeleted: 0,
      deviceCodeDeleted: 0,
      clientAssertionDeleted: 0,
      invitationDeleted: 0,
    });
  });

  it("deletes expired pending invitations only", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await seedInvitation("expired-pending", past);
    await seedInvitation("expired-accepted", past, "accepted");
    await seedInvitation("live-pending", future);

    const result = await runAuthRetentionSweep(env);

    expect(result.invitationDeleted).toBe(1);
    const remaining = await drizzle(db, { schema }).select().from(schema.invitation);
    expect(remaining.map((r) => r.id).sort()).toEqual(["expired-accepted", "live-pending"]);
  });

  it("batches beyond a single page of results", async () => {
    const past = new Date(Date.now() - 60_000);
    const dz = drizzle(db, { schema });
    for (let i = 0; i < 520; i++) {
      await dz.insert(schema.verification).values({
        id: `expired-${i}`,
        identifier: `${i}@example.com`,
        value: "token",
        expiresAt: past,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const result = await runAuthRetentionSweep(env);

    expect(result.verificationDeleted).toBe(520);
    const remaining = await dz.select().from(schema.verification);
    expect(remaining).toHaveLength(0);
  });
});
