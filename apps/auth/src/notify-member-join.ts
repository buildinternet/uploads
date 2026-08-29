import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sendAuthEmail, type SendAuthEmailEnv } from "./email";
import * as schema from "./schema";

export interface NotifyAdminsOfMemberJoinOpts {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  joinerUserId: string;
  joinerEmail: string;
  /** Extra userIds to skip (e.g. the inviter on the email-invite path). */
  excludeUserIds?: string[];
}

/**
 * Emails a workspace's admins/owners that a new member joined. Recipients are
 * members with role admin/owner whose `notifyMemberJoin` preference is on,
 * minus the joiner and any `excludeUserIds`. Fire-and-forget: `sendAuthEmail`
 * never throws, and the recipient lookup is wrapped so a DB failure can't fail
 * the join that triggered this.
 */
export async function notifyAdminsOfMemberJoin(
  env: SendAuthEmailEnv,
  db: DrizzleD1Database<typeof schema>,
  opts: NotifyAdminsOfMemberJoinOpts,
): Promise<void> {
  // Joiner (always) and the inviter (invite path) are excluded in SQL, so the
  // query returns exactly the recipients to mail.
  const excludedUserIds = [opts.joinerUserId, ...(opts.excludeUserIds ?? [])];
  try {
    const rows = await db
      .select({ email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(
        and(
          eq(schema.member.organizationId, opts.organizationId),
          inArray(schema.member.role, ["admin", "owner"]),
          eq(schema.user.notifyMemberJoin, true),
          notInArray(schema.member.userId, excludedUserIds),
        ),
      );

    // Independent sends — fire them concurrently rather than serializing the
    // whole join response behind N sequential email round trips. sendAuthEmail
    // never rejects, so plain Promise.all is safe.
    await Promise.all(
      rows
        .filter((row) => row.email)
        .map((row) =>
          sendAuthEmail(env, {
            to: row.email,
            template: "member-join-admin-notice",
            context: {
              organizationName: opts.organizationName,
              organizationSlug: opts.organizationSlug,
              memberEmail: opts.joinerEmail,
            },
          }),
        ),
    );
  } catch (err) {
    console.error(
      "[notify-member-join] recipient lookup failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
