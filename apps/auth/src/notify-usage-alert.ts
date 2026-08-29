import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { UsageAlertEvent } from "@uploads/email";
import { sendAuthEmail, type SendAuthEmailEnv } from "./email";
import * as schema from "./schema";

export interface NotifyAdminsOfUsageAlertOpts {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  /** Caps that crossed a new band this sweep (storage and/or uploads). */
  events: UsageAlertEvent[];
  /** The workspace's billing plan, so remedy copy stays honest for `pro`. */
  plan?: string;
}

/**
 * Emails a workspace's admins/owners that it is nearing (or has reached) a
 * usage limit. Recipients are members with role admin/owner whose
 * `notifyUsageLimits` preference is on. Fire-and-forget: `sendAuthEmail` never
 * throws, and the recipient lookup is wrapped so a DB failure can't fail the
 * caller (the daily usage sweep).
 */
export async function notifyAdminsOfUsageAlert(
  env: SendAuthEmailEnv,
  db: DrizzleD1Database<typeof schema>,
  opts: NotifyAdminsOfUsageAlertOpts,
): Promise<void> {
  if (opts.events.length === 0) return;
  try {
    const rows = await db
      .select({ email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(
        and(
          eq(schema.member.organizationId, opts.organizationId),
          inArray(schema.member.role, ["admin", "owner"]),
          eq(schema.user.notifyUsageLimits, true),
        ),
      );

    // Independent sends, fired concurrently. sendAuthEmail never rejects, so
    // plain Promise.all is safe.
    await Promise.all(
      rows
        .filter((row) => row.email)
        .map((row) =>
          sendAuthEmail(env, {
            to: row.email,
            template: "usage-limit-alert",
            context: {
              organizationName: opts.organizationName,
              organizationSlug: opts.organizationSlug,
              events: opts.events,
              plan: opts.plan,
            },
          }),
        ),
    );
  } catch (err) {
    console.error(
      "[notify-usage-alert] recipient lookup failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
