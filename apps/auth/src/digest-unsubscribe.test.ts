import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { app } from "./index";
import {
  applyDigestUnsubscribe,
  sendWeeklyDigests,
  type DigestEmailBinding,
} from "./notify-weekly-digest";
import {
  signDigestUnsubscribe,
  signLegacyDigestUnsubscribe,
  unsubscribeUrl,
  verifyDigestUnsubscribe,
} from "./digest-token";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";
import type { WeeklyDigestMessage } from "@uploads/email";

const SECRET = "test-signing-secret-at-least-32-chars-long";
const NOW = new Date("2026-10-12T14:00:00.000Z");

const message: WeeklyDigestMessage = {
  userId: "user-1",
  to: "ada@example.com",
  weekLabel: "Oct 5–11",
  unsubscribes: ["digest", "workspace"],
  user: {
    workspaceName: "Acme",
    workspaceSlug: "acme",
    uploads: 2,
    repos: 1,
  },
  pulses: [
    {
      slug: "acme",
      name: "Acme",
      pulse: {
        uploads: 2,
        uploadsDelta: 1,
        activeMembers: 1,
        activeMembersNew: 0,
        storageBytes: 1000,
        storageDeltaBytes: 1000,
        notes: [],
      },
    },
  ],
};

describe("digest unsubscribe tokens", () => {
  it("round-trips a signed token and rejects tampering and expiry", async () => {
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], "acme", NOW);
    await expect(verifyDigestUnsubscribe(SECRET, token, NOW)).resolves.toMatchObject({
      userId: "user-1",
      kinds: ["digest"],
      workspace: "acme",
    });
    const legacy = await signLegacyDigestUnsubscribe(SECRET, "user-1", ["workspace"], NOW);
    await expect(verifyDigestUnsubscribe(SECRET, legacy, NOW)).resolves.toMatchObject({
      userId: "user-1",
      kinds: ["workspace"],
      workspace: null,
    });
    const [payload, sig] = token.split(".");
    await expect(verifyDigestUnsubscribe(SECRET, `${payload}.${sig}x`, NOW)).resolves.toBeNull();
    const later = new Date(NOW.getTime() + 100 * 24 * 60 * 60 * 1000);
    await expect(verifyDigestUnsubscribe(SECRET, token, later)).resolves.toBeNull();
    expect(unsubscribeUrl("https://auth.uploads.sh/", token)).toContain(
      "https://auth.uploads.sh/digest/unsubscribe?token=",
    );
  });

  it("turns off only that workspace and that kind", async () => {
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
    });
    await orm.insert(schema.organization).values([
      { id: "org-acme", name: "Acme", slug: "acme", createdAt: NOW },
      { id: "org-beta", name: "Beta", slug: "beta", createdAt: NOW },
    ]);
    await orm.insert(schema.member).values([
      {
        id: "m-acme",
        organizationId: "org-acme",
        userId: "user-1",
        role: "owner",
        createdAt: NOW,
        notifyWeeklyDigest: true,
        notifyWeeklyWorkspaceDigest: true,
      },
      {
        id: "m-beta",
        organizationId: "org-beta",
        userId: "user-1",
        role: "member",
        createdAt: NOW,
        notifyWeeklyDigest: true,
        notifyWeeklyWorkspaceDigest: false,
      },
    ]);
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], "acme", NOW);
    const result = await applyDigestUnsubscribe(orm, SECRET, token, NOW);
    expect(result).toEqual({ ok: true, kinds: ["digest"], workspaceName: "Acme" });
    const rows = await orm.select().from(schema.member).where(eq(schema.member.userId, "user-1"));
    const acme = rows.find((row) => row.id === "m-acme");
    const beta = rows.find((row) => row.id === "m-beta");
    expect(acme?.notifyWeeklyDigest).toBe(false);
    expect(acme?.notifyWeeklyWorkspaceDigest).toBe(true);
    expect(beta?.notifyWeeklyDigest).toBe(true);
    await expect(applyDigestUnsubscribe(orm, SECRET, "nope", NOW)).resolves.toEqual({ ok: false });
  });

  it("turns a legacy token off for every membership of that kind", async () => {
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
    });
    await orm.insert(schema.organization).values({
      id: "org-acme",
      name: "Acme",
      slug: "acme",
      createdAt: NOW,
    });
    await orm.insert(schema.member).values({
      id: "m-acme",
      organizationId: "org-acme",
      userId: "user-1",
      role: "owner",
      createdAt: NOW,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: true,
    });
    const token = await signLegacyDigestUnsubscribe(SECRET, "user-1", ["digest"], NOW);
    const result = await applyDigestUnsubscribe(orm, SECRET, token, NOW);
    expect(result).toEqual({ ok: true, kinds: ["digest"], workspaceName: null });
    const [row] = await orm.select().from(schema.member).where(eq(schema.member.id, "m-acme"));
    expect(row?.notifyWeeklyDigest).toBe(false);
    expect(row?.notifyWeeklyWorkspaceDigest).toBe(true);
  });

  it("defaults both membership digest columns to off", async () => {
    const db = createFakeD1();
    await db
      .prepare(
        `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('plain', 'Plain', 'plain@example.com', 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Acme', 'acme', 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m', 'org', 'plain', 'member', 1)`,
      )
      .run();
    const orm = drizzle(db, { schema });
    const [row] = await orm.select().from(schema.member).where(eq(schema.member.id, "m"));
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
    expect(result.sent).toEqual(["user-1|acme"]);
    expect(sent[0]?.html).toContain("2 uploads across 1 repo");
    expect(sent[0]?.text).toContain("Unsubscribe from Acme's weekly summary");
    expect(sent[0]?.text).toContain("Unsubscribe from Acme's admin pulse");
    const header = sent[0]?.headers?.["List-Unsubscribe"] ?? "";
    expect(header).toMatch(/^<https:\/\/auth\.uploads\.sh\/digest\/unsubscribe\?token=/);
    const headerToken = decodeURIComponent(header.slice(header.indexOf("token=") + 6, -1));
    await expect(verifyDigestUnsubscribe(SECRET, headerToken, NOW)).resolves.toMatchObject({
      userId: "user-1",
      kinds: ["digest", "workspace"],
      workspace: "acme",
    });
    expect(sent[0]?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("does not report a send when the EMAIL binding is missing", async () => {
    const result = await sendWeeklyDigests({}, SECRET, [message], NOW);
    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual(["user-1|acme"]);
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
    });
    await orm.insert(schema.organization).values({
      id: "org-acme",
      name: "Acme",
      slug: "acme",
      createdAt: NOW,
    });
    await orm.insert(schema.member).values({
      id: "m-acme",
      organizationId: "org-acme",
      userId: "user-1",
      role: "member",
      createdAt: NOW,
      notifyWeeklyDigest: true,
      notifyWeeklyWorkspaceDigest: false,
    });
    const token = await signDigestUnsubscribe(SECRET, "user-1", ["digest"], "acme", NOW);
    const res = await app.request(
      `/digest/unsubscribe?token=${encodeURIComponent(token)}`,
      {},
      { DB: db, BETTER_AUTH_SECRET: SECRET, AUTH_DIRECT_ORIGIN: "https://auth.uploads.sh" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You're unsubscribed");
    expect(html).toContain("for Acme");
    const [row] = await orm.select().from(schema.member).where(eq(schema.member.id, "m-acme"));
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
