/**
 * Member-cap enforcement (issue #450) against the in-process fake D1 — real
 * migrations, real drizzle queries. `env.API` is a stub Fetcher standing in
 * for apps/api's `GET /internal/billing/member-cap`, so these cover both the
 * counting rules and the fail-open behavior when that call can't be made.
 */
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import { memberCapDenial } from "./member-cap";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

const INTERNAL_KEY = "shh-internal";

/** A stub apps/api service binding answering the member-cap lookup. */
function capBinding(body: unknown, init: ResponseInit = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init }));
  return { fetch: fetch as unknown as Fetcher["fetch"], calls: fetch } as unknown as Fetcher & {
    calls: ReturnType<typeof vi.fn>;
  };
}

describe("memberCapDenial", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  let org: schema.AuthOrganization;

  beforeEach(async () => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
    org = {
      id: crypto.randomUUID(),
      name: "Acme",
      slug: "acme",
      logo: null,
      createdAt: new Date(),
      metadata: null,
      stripeCustomerId: null,
    };
    await orm.insert(schema.organization).values(org);
  });

  // `key: null` means "not configured" — an explicit undefined would fall
  // back to the default parameter and silently configure it.
  function env(api?: Fetcher, key: string | null = INTERNAL_KEY): AuthEnv {
    return {
      DB: db,
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "development",
      ...(api ? { API: api } : {}),
      ...(key ? { BILLING_INTERNAL_KEY: key } : {}),
    } as AuthEnv;
  }

  async function seedUser(): Promise<string> {
    const userId = crypto.randomUUID();
    await orm.insert(schema.user).values({
      id: userId,
      name: "Member",
      email: `member-${userId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: "user",
      banned: null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
    });
    return userId;
  }

  async function seedMembers(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const userId = await seedUser();
      await orm.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId,
        role: index === 0 ? "owner" : "member",
        createdAt: new Date(),
      });
    }
  }

  async function seedPendingInvites(count: number, status = "pending"): Promise<void> {
    const inviterId = await seedUser();
    for (let index = 0; index < count; index++) {
      await orm.insert(schema.invitation).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        email: `pending-${index}@example.com`,
        role: "member",
        status,
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId,
        createdAt: new Date(),
      });
    }
  }

  const args = () => ({ organizationId: org.id, organizationSlug: "acme" });

  it("allows an invite while the workspace is under cap", async () => {
    await seedMembers(2);
    const api = capBinding({ workspace: "acme", cap: 3, message: "nope" });
    expect(await memberCapDenial(env(api), orm, args())).toBeNull();
  });

  it("denies once members alone fill the cap", async () => {
    await seedMembers(3);
    const api = capBinding({
      workspace: "acme",
      cap: 3,
      message: "Free workspaces include 3 members — upgrade to Pro for more.",
    });
    expect(await memberCapDenial(env(api), orm, args())).toEqual({
      code: "member_cap_reached",
      message: "Free workspaces include 3 members — upgrade to Pro for more.",
    });
  });

  it("counts pending invites toward the cap", async () => {
    await seedMembers(1);
    await seedPendingInvites(2);
    const api = capBinding({ workspace: "acme", cap: 3, message: "at cap" });
    expect(await memberCapDenial(env(api), orm, args())).toMatchObject({
      code: "member_cap_reached",
    });
  });

  it("ignores non-pending invitations — a declined invite frees its seat", async () => {
    await seedMembers(1);
    await seedPendingInvites(2, "canceled");
    const api = capBinding({ workspace: "acme", cap: 3, message: "at cap" });
    expect(await memberCapDenial(env(api), orm, args())).toBeNull();
  });

  it("lets a global admin through even at cap", async () => {
    await seedMembers(5);
    const api = capBinding({ workspace: "acme", cap: 3, message: "at cap" });
    expect(
      await memberCapDenial(env(api), orm, { ...args(), inviterIsGlobalAdmin: true }),
    ).toBeNull();
    // The cap lookup isn't even attempted for an operator.
    expect(
      (api as unknown as { calls: { mock: { calls: unknown[] } } }).calls.mock.calls,
    ).toHaveLength(0);
  });

  it("treats a null cap (unlimited) as no denial", async () => {
    await seedMembers(50);
    const api = capBinding({ workspace: "acme", cap: null, message: null });
    expect(await memberCapDenial(env(api), orm, args())).toBeNull();
  });

  it("fails open when the API binding is not configured", async () => {
    await seedMembers(9);
    expect(await memberCapDenial(env(undefined), orm, args())).toBeNull();
  });

  it("fails open when the internal key is not configured", async () => {
    await seedMembers(9);
    const api = capBinding({ workspace: "acme", cap: 3, message: "at cap" });
    expect(await memberCapDenial(env(api, null), orm, args())).toBeNull();
  });

  it("fails open when apps/api answers non-ok", async () => {
    await seedMembers(9);
    const api = capBinding({ error: "boom" }, { status: 500 });
    expect(await memberCapDenial(env(api), orm, args())).toBeNull();
  });

  it("fails open when the cap lookup throws", async () => {
    await seedMembers(9);
    const api = {
      fetch: async () => {
        throw new Error("binding exploded");
      },
    } as unknown as Fetcher;
    expect(await memberCapDenial(env(api), orm, args())).toBeNull();
  });

  it("falls back to its own message when apps/api sends none", async () => {
    await seedMembers(3);
    const api = capBinding({ workspace: "acme", cap: 3 });
    expect(await memberCapDenial(env(api), orm, args())).toMatchObject({
      code: "member_cap_reached",
      message: expect.stringContaining("3"),
    });
  });
});

describe("POST /internal/invite at cap", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  let org: schema.AuthOrganization;
  let inviter: { id: string; email: string };

  beforeEach(async () => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
    org = {
      id: crypto.randomUUID(),
      name: "Acme",
      slug: "acme",
      logo: null,
      createdAt: new Date(),
      metadata: null,
      stripeCustomerId: null,
    };
    await orm.insert(schema.organization).values(org);

    const id = crypto.randomUUID();
    inviter = { id, email: `owner-${id}@example.com` };
    await orm.insert(schema.user).values({
      id,
      name: "Owner",
      email: inviter.email,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: "user",
      banned: null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
    });
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: id,
      role: "owner",
      createdAt: new Date(),
    });
  });

  function app() {
    return new Hono<{ Bindings: AuthEnv }>().route("/internal", internal);
  }

  function env(cap: number | null): AuthEnv {
    return {
      DB: db,
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "development",
      BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
      BILLING_INTERNAL_KEY: INTERNAL_KEY,
      API: capBinding({
        workspace: "acme",
        cap,
        message: "Free workspaces include 1 member — upgrade to Pro for more.",
      }),
    } as unknown as AuthEnv;
  }

  function invite(body: Record<string, unknown>, e: AuthEnv) {
    return app().request(
      "/internal/invite",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationSlug: "acme",
          email: "new@example.com",
          inviterUserId: inviter.id,
          ...body,
        }),
      },
      e,
    );
  }

  it("403s with member_cap_reached when the single seat is already taken", async () => {
    const res = await invite({}, env(1));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string; message: string } }).toMatchObject({
      error: {
        code: "member_cap_reached",
        message: "Free workspaces include 1 member — upgrade to Pro for more.",
      },
    });
    const rows = await orm.select().from(schema.invitation);
    expect(rows).toHaveLength(0);
  });

  it("still creates the invite when there's room", async () => {
    const res = await invite({}, env(3));
    expect(res.status).toBe(201);
    const rows = await orm.select().from(schema.invitation);
    expect(rows).toHaveLength(1);
  });

  it("re-issues an already-pending invite at cap rather than 403ing", async () => {
    // The seat is already spent by this very invitation, so returning the
    // existing link consumes nothing new — the idempotent path must stay
    // reachable for a workspace sitting exactly at its cap.
    await orm.insert(schema.invitation).values({
      id: crypto.randomUUID(),
      organizationId: org.id,
      email: "new@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: inviter.id,
      createdAt: new Date(),
    });

    const res = await invite({}, env(2));
    expect(res.status).toBe(200);
    const rows = await orm.select().from(schema.invitation);
    expect(rows).toHaveLength(1);
  });
});
