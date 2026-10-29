import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { UsageAlertEvent, WorkspaceStorageMode } from "@uploads/email";
import { sendAuthEmail, type SendAuthEmailEnv } from "./email";
import * as schema from "./schema";

/** Operator FYI starts here. The 50% band still emails the workspace only. */
const OPERATOR_STORAGE_ALERT_MIN = 90;

const OPERATOR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export interface NotifyOperatorOfStorageAlertOpts {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  events: UsageAlertEvent[];
  /** From the API sweep. Absent renders as "unknown". */
  storageMode?: WorkspaceStorageMode;
}

/**
 * FYI the uploads.sh operator when storage crosses 90% or 100%. Same sweep
 * and KV marker as the customer mail, so it fires once per band rise, not
 * per upload. A put that is rejected while stored usage is still under the
 * next band does not send its own mail — the daily 100% band is the
 * limit-reached notice. Never throws: a lookup or send failure must not
 * fail the customer notification or retry it.
 */
export async function notifyOperatorOfStorageAlert(
  env: SendAuthEmailEnv,
  db: DrizzleD1Database<typeof schema>,
  opts: NotifyOperatorOfStorageAlertOpts,
): Promise<void> {
  const event = opts.events.find(
    (item) => item.cap === "storage" && item.threshold >= OPERATOR_STORAGE_ALERT_MIN,
  );
  if (!event) return;

  const to = env.OPERATOR_ALERT_EMAIL?.trim() ?? "";
  if (!OPERATOR_EMAIL_RE.test(to)) {
    console.warn(
      JSON.stringify({
        message: "storage_operator_alert_skipped",
        workspace: opts.organizationSlug,
        reason: to ? "invalid" : "unset",
      }),
    );
    return;
  }

  try {
    const rows = await db
      .select({ email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(
        and(eq(schema.member.organizationId, opts.organizationId), eq(schema.member.role, "owner")),
      );
    const ownerEmails = [
      ...new Set(rows.map((row) => row.email).filter((email) => email.length > 0)),
    ].sort();
    await sendAuthEmail(env, {
      to,
      template: "storage-operator-alert",
      context: {
        organizationName: opts.organizationName,
        organizationSlug: opts.organizationSlug,
        organizationId: opts.organizationId,
        event,
        storageMode: opts.storageMode,
        ownerEmails,
      },
    });
  } catch (err) {
    console.error(
      "[notify-usage-alert] operator FYI failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
