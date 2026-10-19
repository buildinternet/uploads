/**
 * Service-wide operator settings (`platform_settings`, one row per key),
 * changed from Admin → Models. uploads-slack reads the same table over the
 * shared D1 binding (apps/slack/src/mentions.ts), so a change applies to the
 * next mention with no deploy. No imports: apps/slack's tests load this file.
 */

type D1Queryable = Pick<D1Database, "prepare">;

/** The OpenRouter model the Slack mention agent runs. */
export const SLACK_AGENT_MODEL_KEY = "slack_agent_model";

/**
 * Used when no operator has picked one. apps/slack's `DEFAULT_AGENT_MODEL`
 * must match; apps/slack/test/mentions.test.ts checks it.
 */
export const SLACK_AGENT_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** `provider/model`, with OpenRouter's variant suffix (`:free`) allowed. */
export const OPENROUTER_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/i;

export interface PlatformSetting {
  value: string;
  updatedBy: string;
  updatedAt: string;
}

export async function getPlatformSetting(
  db: D1Queryable,
  key: string,
): Promise<PlatformSetting | null> {
  const row = await db
    .prepare("SELECT value, updated_by, updated_at FROM platform_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_by: string; updated_at: string }>();
  return row ? { value: row.value, updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
}

/** Stores `value`, or deletes the row (back to the default) when it is null. */
export async function setPlatformSetting(
  db: D1Queryable,
  key: string,
  value: string | null,
  updatedBy: string,
  now = new Date(),
): Promise<void> {
  if (value === null) {
    await db.prepare("DELETE FROM platform_settings WHERE key = ?").bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(key, value, updatedBy, now.toISOString())
    .run();
}
