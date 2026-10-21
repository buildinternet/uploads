-- Hold DMs uploads-slack sent (apps/slack/src/holds.ts), so the message can
-- be rewritten with chat.update once the hold is approved or the held file
-- is deleted anywhere (web, CLI, MCP, Slack). A row is removed once its
-- message has been rewritten.
CREATE TABLE IF NOT EXISTS slack_hold_messages (
  channel    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  workspace  TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel, ts)
);

CREATE INDEX IF NOT EXISTS slack_hold_messages_file
  ON slack_hold_messages (workspace, object_key);
