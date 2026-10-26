-- Slack app installs (apps/slack): one row per Slack workspace (team) that
-- installed the uploads.sh app through the OAuth flow at
-- agents.uploads.sh/slack/install. Written and read only by uploads-slack.
--
-- bot_token is sealed with the worker's SLACK_TOKENS_KEY (AES-GCM,
-- `enc:v1:` prefix); never store it in the clear. An uninstall or token
-- revocation clears the token and stamps revoked_at, keeping the row as a
-- record of the install. Reinstalling the same team overwrites the row.
CREATE TABLE IF NOT EXISTS slack_installations (
  team_id TEXT PRIMARY KEY,
  team_name TEXT,
  enterprise_id TEXT,
  app_id TEXT NOT NULL,
  bot_user_id TEXT,
  bot_token TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  installed_by_slack_user_id TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
