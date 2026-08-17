/**
 * Retention sweep for Better Auth D1 tables that Better Auth itself does not
 * proactively clean up (plan Phase 5, item 4 of buildinternet/uploads#102):
 *
 * - `verification`: magic-link tokens. Better Auth deletes a row when it is
 *   successfully consumed, but an unused link just expires in place — rows
 *   accumulate for every magic-link send that's ignored or expires.
 * - `device_code`: device-authorization (RFC 8628) pending requests. Better
 *   Auth only deletes a row when a poll notices `expired_token` — an
 *   abandoned `uploads login` (user never opens the approval page, or opens
 *   it but never approves) leaves the row behind forever. Growth here is
 *   unauthenticated (`POST /device/code` needs no auth), bounded only by the
 *   AUTH_RATE_LIMITER binding.
 *
 * Deletes are batched (id-select then delete-by-id, looped) so a table that
 * has grown large doesn't turn one sweep into a single unbounded statement.
 */
import { drizzle } from "drizzle-orm/d1";
import { inArray, lt } from "drizzle-orm";
import * as schema from "./schema";
import type { AuthEnv } from "./auth";

const BATCH_SIZE = 500;

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Batched delete of expired `verification` rows: select ids, delete by id, repeat. */
async function purgeExpiredVerification(db: Db, now: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db
      .select({ id: schema.verification.id })
      .from(schema.verification)
      .where(lt(schema.verification.expiresAt, now))
      .limit(BATCH_SIZE);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    await db.delete(schema.verification).where(inArray(schema.verification.id, ids));
    deleted += ids.length;

    // A batch smaller than the page size means there's nothing left to page
    // through; avoid one extra round-trip that would just return empty.
    if (rows.length < BATCH_SIZE) break;
  }
  return deleted;
}

/** Batched delete of expired `device_code` rows: select ids, delete by id, repeat. */
async function purgeExpiredDeviceCode(db: Db, now: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db
      .select({ id: schema.deviceCode.id })
      .from(schema.deviceCode)
      .where(lt(schema.deviceCode.expiresAt, now))
      .limit(BATCH_SIZE);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    await db.delete(schema.deviceCode).where(inArray(schema.deviceCode.id, ids));
    deleted += ids.length;

    if (rows.length < BATCH_SIZE) break;
  }
  return deleted;
}

export interface RetentionSweepResult {
  verificationDeleted: number;
  deviceCodeDeleted: number;
}

export async function runAuthRetentionSweep(env: AuthEnv): Promise<RetentionSweepResult> {
  const db = drizzle(env.DB, { schema });
  const now = new Date();

  const verificationDeleted = await purgeExpiredVerification(db, now);
  const deviceCodeDeleted = await purgeExpiredDeviceCode(db, now);

  console.log(
    JSON.stringify({
      message: "auth_retention_sweep",
      verificationDeleted,
      deviceCodeDeleted,
    }),
  );

  return { verificationDeleted, deviceCodeDeleted };
}
