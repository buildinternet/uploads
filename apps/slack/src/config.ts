/**
 * Worker configuration and credential lookup.
 *
 * Each Slack workspace that installs the app through the OAuth flow
 * (oauth.ts) gets its own bot token, sealed in D1 (installs.ts). That is
 * the only place a token comes from.
 */
import { installedBotToken } from "./installs";

export interface SlackEnv {
  WEB_ORIGIN?: string;
  API_ORIGIN?: string;
  /** This worker's public origin; the OAuth redirect URI is built from it. */
  SLACK_ORIGIN?: string;
  SLACK_APP_ID?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Master secret for sealing bot tokens and signing OAuth state. */
  SLACK_TOKENS_KEY?: string;
  SLACK_SIGNING_SECRET?: string;
  /** Shared D1 (uploads-production); holds slack_installations and slack_user_links. */
  DB?: D1Database;
  /**
   * uploads-api over a service binding: its public read endpoints, and the
   * internal Approve route for held uploads. Absent in local dev.
   */
  API?: Fetcher;
}

/** The bot token for `teamId`, or null when the app isn't installed there. */
export async function botTokenFor(env: SlackEnv, teamId: string): Promise<string | null> {
  if (!env.DB) return null;
  try {
    return await installedBotToken(env.DB, env.SLACK_TOKENS_KEY, teamId);
  } catch (err) {
    console.error("slack.config: install lookup failed", { team: teamId, err: String(err) });
    return null;
  }
}
