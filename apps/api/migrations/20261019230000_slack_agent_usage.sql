-- Mentions the Slack app's agent answered, per Slack workspace (team) per
-- UTC day. uploads-slack adds one before each model run and stops answering
-- once a team passes its daily cap (apps/slack/src/mentions.ts), since every
-- answer is a billed model call.
CREATE TABLE IF NOT EXISTS slack_agent_usage (
  team_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  mentions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, day)
);
