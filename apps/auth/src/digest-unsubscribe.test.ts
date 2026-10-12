import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { app } from "./index";
import {
  applyDigestUnsubscribe,
  sendWeeklyDigests,
  type DigestEmailBinding,
} from "./notify-weekly-digest";
import { signDigestUnsubscribe, unsubscribeUrl, verifyDigestUnsubscribe } from "./digest-token";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";
import type { WeeklyDigestMessage } from "@uploads/email";

const SECRET = "test-signing-secret-at-least-32-chars-long";
const NOW = new Date("2026-10-12T14:00:00.000Z");

const message: WeeklyDigestMessage = {
  userId: "user-1",
  to: "ada@example.com",
  weekLabel: "Oct 5–12",
  omittedWorkspaces: 0,
  unsubscribes: ["digest", "workspace"],
  sections: [
    {
      slug: "acme",
      name: "Acme",
      blurb: "Acme uploaded 2 files this week.",
      uploads: 2,
      bytesAdded: 1000,
      repos: [],
      screenshots: [],
      pulls: [],
      issues: [],
      pages: [],
      galleries: [],
      galleryCount: 0,
      feeds: 0,
    },
  ],
};

describe("digest unsubscribe tokens", () => {
  it("round-trips a signed token and rejects tampering and expiry", async () => {
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], NOW);
    await expect(verifyDigestUnsubscribe(SECRET, token, NOW)).resolves.toMatchObject({
      userId: "user-1",
      kinds: ["digest"],
    });
    const [payload, sig] = token.split(".");
    await expect(verifyDigestUnsubscribe(SECRET, `${payload}.${sig}x`, NOW)).resolves.toBeNull();
    const later = new Date(NOW.getTime() + 100 * 24 * 60 * 60 * 1000);
    await expect(verifyDigestUnsubscribe(SECRET, token, later)).resolves.toBeNull();
    expect(unsubscribeUrl("https://auth.uploads.sh/", token)).toContain(
      "https://auth.uploads.sh/digest/unsubscribe?token=",
    );
  });

  it("turns off only the kind named in the token", async () => {
    const db = createFakeD1();
    const orm = drizzle(db, { schema });
    await orm.insert(schema.user).values({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
      role: "user",
      banned: null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
      notifyMemberJoin: true,
      notifyUsageLimits: true,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: true,
    });
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], NOW);
    const result = await applyDigestUnsubscribe(orm, SECRET, token, NOW);
    expect(result).toEqual({ ok: true, kinds: ["digest"] });
    const [row] = await orm.select().from(schema.user).where(eq(schema.user.id, "user-1"));
    expect(row?.notifyWeeklyDigest).toBe(false);
    expect(row?.notifyWeeklyWorkspaceDigest).toBe(true);
    await expect(applyDigestUnsubscribe(orm, SECRET, "nope", NOW)).resolves.toEqual({ ok: false });
  });

  it("defaults both digest columns to off", async () => {
    const db = createFakeD1();
    await db
      .prepare(
        `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('plain', 'Plain', 'plain@example.com', 1, 1)`,
      )
      .run();
    const orm = drizzle(db, { schema });
    const [row] = await orm.select().from(schema.user).where(eq(schema.user.id, "plain"));
    expect(row?.notifyWeeklyDigest).toBe(false);
    expect(row?.notifyWeeklyWorkspaceDigest).toBe(false);
  });
});

describe("sendWeeklyDigests", () => {
  it("sends html and text with a one-click unsubscribe header", async () => {
    const sent: Array<{ html?: string; text?: string; headers?: Record<string, string> }> = [];
    const email: DigestEmailBinding = {
      send: async (msg) => {
        sent.push(msg);
      },
    };
    const result = await sendWeeklyDigests(
      {
        EMAIL: email,
        WEB_ORIGIN: "https://uploads.sh",
        AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh",
        BETTER_AUTH_SECRET: SECRET,
      },
      SECRET,
      [message],
      NOW,
    );
    expect(result.sent).toEqual(["user-1"]);
    expect(sent[0]?.html).toContain("Acme uploaded 2 files");
    expect(sent[0]?.text).toContain("Unsubscribe from this weekly summary");
    expect(sent[0]?.text).toContain("Unsubscribe from workspace summaries");
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/auth\.uploads\.sh\/digest\/unsubscribe\?token=/,
    );
    expect(sent[0]?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("does not report a send when the EMAIL binding is missing", async () => {
    const result = await sendWeeklyDigests({}, SECRET, [message], NOW);
    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual(["user-1"]);
  });
});

describe("GET /digest/unsubscribe", () => {
  it("opts the user out and renders a confirmation", async () => {
    const db = createFakeD1();
    const orm = drizzle(db, { schema });
    await orm.insert(schema.user).values({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
      role: "user",
      banned: null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
      notifyMemberJoin: true,
      notifyUsageLimits: true,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: false,
    });
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], NOW);
    const res = await app.request(
      `/digest/unsubscribe?token=${encodeURIComponent(token)}`,
      {},
      { DB: db, BETTER_AUTH_SECRET: SECRET, AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You're unsubscribed");
    const [row] = await orm.select().from(schema.user).where(eq(schema.user.id, "user-1"));
    expect(row?.notifyWeeklyDigest).toBe(false);
  });

  it("rejects a bad token", async () => {
    const db = createFakeD1();
    const res = await app.request(
      "/digest/unsubscribe?token=nope",
      {},
      {
        DB: db,
        BETTER_AUTH_SECRET: SECRET,
      },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("doesn't work");
  });
});
