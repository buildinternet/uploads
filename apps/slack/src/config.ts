/**
 * Worker configuration and credential lookup.
 *
 * v1 is a single-workspace install: one bot token in a secret, optionally
 * pinned to one Slack team. Distributing the app to other workspaces needs
 * the OAuth install flow and a per-team token store; when that lands, only
 * botTokenFor() changes and handlers keep calling it the same way.
 */

export interface SlackEnv {
  WEB_ORIGIN?: string;
  API_ORIGIN?: string;
  SLACK_TEAM_ID?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  /** uploads-api over a service binding, for its public read endpoints. Absent in local dev. */
  API?: Fetcher;
}

/** The bot token for `teamId`, or null when this install doesn't cover that team. */
export function botTokenFor(env: SlackEnv, teamId: string): string | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  const pinned = env.SLACK_TEAM_ID?.trim();
  if (pinned && pinned !== teamId) return null;
  return token;
}
