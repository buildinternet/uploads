/**
 * Which bot scopes each feature needs, and which ones a workspace's install
 * is missing.
 *
 * Slack never upgrades an install on its own: adding a scope only changes
 * what new installs request, and every existing workspace keeps its old
 * token until someone there runs the OAuth flow again (Slack's "App
 * lifecycle & distribution" guide). Slack adds the new grant to the old one.
 * So the app compares each install's granted scopes (`slack_installations.
 * scopes`, from `oauth.v2.access`) with this list, asks for an update where
 * something is missing (the Home tab and uploads.sh account settings), and
 * skips a feature it can't run instead of calling Slack and failing with
 * `missing_scope`.
 *
 * `BOT_SCOPES` is what `/slack/install` requests and must equal the bot
 * scopes in manifest.json; test/scopes.test.ts checks both, and
 * apps/api/src/slack-scopes.ts mirrors the list for account settings.
 */

export const FEATURE_SCOPES = {
  /** Link previews. */
  unfurl: ["links:read", "links:write"],
  /** The Slack name on the uploads.sh connect page. */
  connect: ["users:read"],
  /** Held-upload DMs and their buttons. */
  holds: ["chat:write", "im:write"],
} as const satisfies Record<string, readonly string[]>;

export type Feature = keyof typeof FEATURE_SCOPES;

/** Every bot scope the app requests, sorted. */
export const BOT_SCOPES: readonly string[] = [
  ...new Set(Object.values(FEATURE_SCOPES).flat()),
].sort();

/** Parses the comma-separated `scope` string Slack returns from `oauth.v2.access`. */
export function parseScopes(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Scopes from `wanted` (default: all of them) that `granted` lacks. */
export function missingScopes(
  granted: Set<string>,
  wanted: readonly string[] = BOT_SCOPES,
): string[] {
  return wanted.filter((scope) => !granted.has(scope));
}

/** Whether an install with `granted` can run `feature`. */
export function canRun(granted: Set<string>, feature: Feature): boolean {
  return missingScopes(granted, FEATURE_SCOPES[feature]).length === 0;
}

/** Plain words for what's missing, for the update prompt. */
export function missingFeaturesText(granted: Set<string>): string | null {
  const labels: Record<Feature, string> = {
    unfurl: "link previews",
    connect: "connecting accounts",
    holds: "held-upload messages",
  };
  const missing = (Object.keys(FEATURE_SCOPES) as Feature[])
    .filter((f) => !canRun(granted, f))
    .map((f) => labels[f]);
  if (missing.length === 0) return null;
  return missing.length === 1
    ? missing[0]!
    : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
}
