import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageAlertEvent } from "@uploads/email";
import type { EmailBinding } from "./email";
import { notifyAdminsOfUsageAlert } from "./notify-usage-alert";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

const orgId = "org-1";
const EVENTS: UsageAlertEvent[] = [
  { cap: "storage", threshold: 90, used: 225_000_000, limit: 250_000_000 },
];

describe("notifyAdminsOfUsageAlert", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
    await orm.insert(schema.organization).values({
      id: orgId,
      name: "Acme",
      slug: "acme",
      logo: null,
      createdAt: new Date(),
      metadata: null,
      stripeCustomerId: null,
    });
  });

  async function seedUser(over: Partial<schema.AuthUser> = {}): Promise<schema.AuthUser> {
    const u: schema.AuthUser = {
      id: over.id ?? crypto.randomUUID(),
      name: "U",
      email: over.email ?? `u-${crypto.randomUUID()}@example.com`,
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
      notifyMemberJoin: over.notifyMemberJoin ?? true,
      notifyUsageLimits: over.notifyUsageLimits ?? true,
    };
    await orm.insert(schema.user).values(u);
    return u;
  }

  async function seedMember(userId: string, role: string): Promise<void> {
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role,
      createdAt: new Date(),
    });
  }

  function emailCapture(): { EMAIL: EmailBinding; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn().mockResolvedValue({});
    return { EMAIL: { send }, send };
  }

  const baseEnv = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "production" as const };

  it("emails admins and owners, not plain members", async () => {
    const admin = await seedUser();
    const owner = await seedUser();
    const plain = await seedUser();
    await seedMember(admin.id, "admin");
    await seedMember(owner.id, "owner");
    await seedMember(plain.id, "member");
    const { EMAIL, send } = emailCapture();

    await notifyAdminsOfUsageAlert({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      events: EVENTS,
    });

    const recipients = send.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual([admin.email, owner.email].sort());
    // The usage template rode through, not some other email.
    expect(send.mock.calls[0]?.[0].subject).toContain("90%");
  });

  it("skips recipients who turned the preference off", async () => {
    const admin = await seedUser({ notifyUsageLimits: false });
    await seedMember(admin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfUsageAlert({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      events: EVENTS,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when there are no events", async () => {
    const admin = await seedUser();
    await seedMember(admin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfUsageAlert({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      events: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when the DB read fails", async () => {
    const poison = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    ) as never;
    const { EMAIL, send } = emailCapture();
    await expect(
      notifyAdminsOfUsageAlert({ ...baseEnv, EMAIL }, poison, {
        organizationId: orgId,
        organizationName: "Acme",
        organizationSlug: "acme",
        events: EVENTS,
      }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
