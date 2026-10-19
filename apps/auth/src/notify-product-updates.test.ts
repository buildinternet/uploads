import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import {
  signDigestUnsubscribe,
  signUpdatesUnsubscribe,
  verifyDigestUnsubscribe,
  verifyUpdatesUnsubscribe,
} from "./digest-token";
import { app } from "./index";
import type { DigestEmailBinding } from "./notify-weekly-digest";
import { sendCliUpgradeEmails } from "./notify-product-updates";
import { hasProductUpdatesOptOut } from "./product-updates";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

const SECRET = "test-signing-secret-at-least-32-chars-long";
const NOW = new Date();

describe("product updates unsubscribe tokens", () => {
  it("never pass for a digest token, or the other way round", async () => {
    const updates = await signUpdatesUnsubscribe(SECRET, "user-1", NOW);
    await expect(verifyUpdatesUnsubscribe(SECRET, updates, NOW)).resolves.toEqual({
      userId: "user-1",
    });
    await expect(verifyDigestUnsubscribe(SECRET, updates, NOW)).resolves.toBeNull();
    const digest = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], "acme", NOW);
    await expect(verifyUpdatesUnsubscribe(SECRET, digest, NOW)).resolves.toBeNull();
    await expect(verifyUpdatesUnsubscribe("another-secret", updates, NOW)).resolves.toBeNull();
  });
});

describe("sendCliUpgradeEmails", () => {
  it("sends with a one-click unsubscribe header", async () => {
    const sent: Array<{ subject: string; text?: string; headers?: Record<string, string> }> = [];
    const email: DigestEmailBinding = {
      send: async (msg) => {
        sent.push(msg);
      },
    };
    const result = await sendCliUpgradeEmails(
      { EMAIL: email, AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh" },
      SECRET,
      [
        {
          userId: "user-1",
          to: "ada@example.com",
          currentVersion: "0.58.2",
          minimumVersion: "0.59.0",
        },
      ],
      NOW,
    );
    expect(result).toEqual({ sent: ["user-1"], failed: [] });
    expect(sent[0]?.subject).toBe("Update your uploads CLI to 0.59.0");
    expect(sent[0]?.text).toContain("You're using version 0.58.2 of the uploads CLI.");
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/auth\.uploads\.sh\/updates\/unsubscribe\?token=/,
    );
  });

  it("reports a failure when the EMAIL binding is missing", async () => {
    const result = await sendCliUpgradeEmails(
      {},
      SECRET,
      [{ userId: "user-1", to: "ada@example.com", currentVersion: null, minimumVersion: "0.59.0" }],
      NOW,
    );
    expect(result).toEqual({ sent: [], failed: ["user-1"] });
  });
});

describe("GET /updates/unsubscribe", () => {
  it("turns product updates off", async () => {
    const db = createFakeD1();
    const orm = drizzle(db, { schema });
    await orm.insert(schema.user).values({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const token = await signUpdatesUnsubscribe(SECRET, "user-1", NOW);
    const res = await app.request(
      `/updates/unsubscribe?token=${encodeURIComponent(token)}`,
      {},
      { DB: db, BETTER_AUTH_SECRET: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You won't get product update emails anymore.");
    const [row] = await orm.select().from(schema.user).where(eq(schema.user.id, "user-1"));
    expect(row?.notifyProductUpdates).toBe(false);
  });

  it("rejects a bad token", async () => {
    const res = await app.request(
      "/updates/unsubscribe?token=nope",
      {},
      { DB: createFakeD1(), BETTER_AUTH_SECRET: SECRET },
    );
    expect(res.status).toBe(400);
  });
});

describe("hasProductUpdatesOptOut", () => {
  it("reads only the exact opt-out cookie", () => {
    const req = (cookie: string) => new Headers({ cookie });
    expect(hasProductUpdatesOptOut(req("a=1; uploads_product_updates=off"))).toBe(true);
    expect(hasProductUpdatesOptOut(req("uploads_product_updates=on"))).toBe(false);
    expect(hasProductUpdatesOptOut(new Headers())).toBe(false);
    expect(hasProductUpdatesOptOut(undefined)).toBe(false);
  });
});
