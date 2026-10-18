/**
 * Worker configuration and credential lookup.
 *
 * Each Slack workspace that installs the app through the OAuth flow
 * (oauth.ts) gets its own bot token, sealed in D1 (installs.ts). The
 * original single-workspace setup, one token in SLACK_BOT_TOKEN for the
 * team in SLACK_TEAM_ID, still works as a fallback for that one team until
 * it reinstalls through OAuth, after which the D1 install wins.
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
  /** Legacy single-workspace token, used only for SLACK_TEAM_ID. */
  SLACK_BOT_TOKEN?: string;
  SLACK_TEAM_ID?: string;
  /** Shared D1 (uploads-production); holds slack_installations. */
  DB?: D1Database;
  /** uploads-api over a service binding, for its public read endpoints. Absent in local dev. */
  API?: Fetcher;
}

function legacyToken(env: SlackEnv, teamId: string): string | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  const team = env.SLACK_TEAM_ID?.trim();
  return token && team && team === teamId ? token : null;
}

/** The bot token for `teamId`, or null when the app isn't installed there. */
export async function botTokenFor(env: SlackEnv, teamId: string): Promise<string | null> {
  if (env.DB) {
    try {
      const token = await installedBotToken(env.DB, env.SLACK_TOKENS_KEY, teamId);
      if (token) return token;
    } catch (err) {
      console.error("slack.config: install lookup failed", { team: teamId, err: String(err) });
    }
  }
  return legacyToken(env, teamId);
}
