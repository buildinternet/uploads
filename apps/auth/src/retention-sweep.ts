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
 *   unauthenticated (`POST /device/code` needs no auth), bounded only by
 *   Better Auth's database-backed rate limiter (src/auth.ts `rateLimit`).
 * - `oauth_client_assertion`: `private_key_jwt` replay tombstones, one per
 *   accepted `jti` (CIMD clients such as Vercel Connect). oauth-provider
 *   inserts them and never deletes; a row is useless once the assertion's
 *   `exp` (at most 300 s out) has passed.
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

/** Tables the sweep pages through: an `id` key and an `expiresAt` timestamp. */
type ExpiringTable =
  | typeof schema.verification
  | typeof schema.deviceCode
  | typeof schema.oauthClientAssertion;

/** Batched delete of expired rows: select ids, delete by id, repeat. */
async function purgeExpired(db: Db, table: ExpiringTable, now: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(lt(table.expiresAt, now))
      .limit(BATCH_SIZE);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    await db.delete(table).where(inArray(table.id, ids));
    deleted += ids.length;

    // A batch smaller than the page size means there's nothing left to page
    // through; avoid one extra round-trip that would just return empty.
    if (rows.length < BATCH_SIZE) break;
  }
  return deleted;
}

export interface RetentionSweepResult {
  verificationDeleted: number;
  deviceCodeDeleted: number;
  clientAssertionDeleted: number;
}

export async function runAuthRetentionSweep(env: AuthEnv): Promise<RetentionSweepResult> {
  const db = drizzle(env.DB, { schema });
  const now = new Date();

  const verificationDeleted = await purgeExpired(db, schema.verification, now);
  const deviceCodeDeleted = await purgeExpired(db, schema.deviceCode, now);
  const clientAssertionDeleted = await purgeExpired(db, schema.oauthClientAssertion, now);

  console.log(
    JSON.stringify({
      message: "auth_retention_sweep",
      verificationDeleted,
      deviceCodeDeleted,
      clientAssertionDeleted,
    }),
  );

  return { verificationDeleted, deviceCodeDeleted, clientAssertionDeleted };
}
