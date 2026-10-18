/**
 * Per-workspace Slack installs, in the shared D1 table `slack_installations`
 * (migration: apps/api/migrations/20261018160000_slack_installations.sql).
 * Bot tokens are sealed with SLACK_TOKENS_KEY before they are written.
 */
import { open, seal } from "./crypto";

export interface InstallRecord {
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  appId: string;
  botUserId: string | null;
  botToken: string;
  scopes: string;
  installedBySlackUserId: string | null;
}

interface InstallRow {
  bot_token: string | null;
  revoked_at: string | null;
}

/** Creates or replaces the install for a team. A reinstall clears any earlier revocation. */
export async function saveInstall(
  db: D1Database,
  tokensKey: string | undefined,
  record: InstallRecord,
  now = new Date(),
): Promise<void> {
  const sealed = await seal(tokensKey, record.botToken);
  const stamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO slack_installations
         (team_id, team_name, enterprise_id, app_id, bot_user_id, bot_token, scopes,
          installed_by_slack_user_id, installed_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (team_id) DO UPDATE SET
         team_name = excluded.team_name,
         enterprise_id = excluded.enterprise_id,
         app_id = excluded.app_id,
         bot_user_id = excluded.bot_user_id,
         bot_token = excluded.bot_token,
         scopes = excluded.scopes,
         installed_by_slack_user_id = excluded.installed_by_slack_user_id,
         updated_at = excluded.updated_at,
         revoked_at = NULL`,
    )
    .bind(
      record.teamId,
      record.teamName,
      record.enterpriseId,
      record.appId,
      record.botUserId,
      sealed,
      record.scopes,
      record.installedBySlackUserId,
      stamp,
      stamp,
    )
    .run();
}

/** The team's bot token, or null when it never installed or has uninstalled. */
export async function installedBotToken(
  db: D1Database,
  tokensKey: string | undefined,
  teamId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT bot_token, revoked_at FROM slack_installations WHERE team_id = ?")
    .bind(teamId)
    .first<InstallRow>();
  if (!row?.bot_token || row.revoked_at) return null;
  return open(tokensKey, row.bot_token);
}

/** Uninstall or revocation: drop the token, keep the row as a record. */
export async function revokeInstall(db: D1Database, teamId: string, now = new Date()) {
  const stamp = now.toISOString();
  await db
    .prepare(
      `UPDATE slack_installations
         SET bot_token = NULL, revoked_at = ?, updated_at = ?
       WHERE team_id = ? AND revoked_at IS NULL`,
    )
    .bind(stamp, stamp, teamId)
    .run();
}
