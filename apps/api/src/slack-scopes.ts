/**
 * The Slack app's bot scopes, mirrored from apps/slack/src/scopes.ts so
 * account settings can tell a user their Slack workspace needs to approve
 * new permissions. apps/slack/test/scopes.test.ts fails if this list, the
 * worker's list, and apps/slack/manifest.json disagree. No imports: that
 * test loads this file directly.
 */
export const API_SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "commands",
  "groups:history",
  "im:write",
  "links:read",
  "links:write",
  "reactions:write",
  "users:read",
];

/** Scopes from `API_SLACK_BOT_SCOPES` missing from a comma-separated grant. */
export function missingSlackScopes(granted: string | null | undefined): string[] {
  const have = new Set(
    (granted ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return API_SLACK_BOT_SCOPES.filter((scope) => !have.has(scope));
}
