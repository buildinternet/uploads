-- Service-wide settings operators change from /admin, one row per key. The
-- first is `slack_agent_model`: the OpenRouter model the Slack app's mention
-- agent runs (apps/slack/src/agent.ts), read by uploads-slack on each
-- mention. No row means the built-in default. `updated_by` is the operator's
-- name or email at the time of the change.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
