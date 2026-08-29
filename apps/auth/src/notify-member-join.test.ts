import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailBinding } from "./email";
import { notifyAdminsOfMemberJoin } from "./notify-member-join";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

describe("notifyAdminsOfMemberJoin", () => {
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
    };
    await orm.insert(schema.user).values(u);
    return u;
  }

  async function seedMember(organizationId: string, userId: string, role: string): Promise<void> {
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    });
  }

  function emailCapture(): { EMAIL: EmailBinding; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn().mockResolvedValue({});
    return { EMAIL: { send }, send };
  }

  const orgId = "org-1";
  const baseEnv = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "production" as const };

  it("emails admins and owners, not plain members or the joiner", async () => {
    const admin = await seedUser();
    const owner = await seedUser();
    const plain = await seedUser();
    const joiner = await seedUser();
    await seedMember(orgId, admin.id, "admin");
    await seedMember(orgId, owner.id, "owner");
    await seedMember(orgId, plain.id, "member");
    await seedMember(orgId, joiner.id, "owner"); // joiner even as owner is excluded
    const { EMAIL, send } = emailCapture();

    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
    });

    const recipients = send.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual([admin.email, owner.email].sort());
  });

  it("skips recipients who turned the preference off", async () => {
    const admin = await seedUser({ notifyMemberJoin: false });
    const joiner = await seedUser();
    await seedMember(orgId, admin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("excludes extra excludeUserIds (the inviter)", async () => {
    const inviter = await seedUser();
    const otherAdmin = await seedUser();
    const joiner = await seedUser();
    await seedMember(orgId, inviter.id, "admin");
    await seedMember(orgId, otherAdmin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
      excludeUserIds: [inviter.id],
    });
    const recipients = send.mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual([otherAdmin.email]);
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
      notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, poison, {
        organizationId: orgId,
        organizationName: "Acme",
        organizationSlug: "acme",
        joinerUserId: "j",
        joinerEmail: "j@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
