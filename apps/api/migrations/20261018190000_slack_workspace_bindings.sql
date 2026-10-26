-- Which uploads.sh workspaces a Slack workspace (team) speaks for (#1165).
--
-- A workspace admin or owner turns this on from workspace Settings → Slack
-- (`PUT /me/slack/workspaces/:name/teams/:teamId`), for a Slack team they
-- have linked their own account in (slack_user_links). Once bound, full
-- members of that Slack team can run `/uploads search` over the workspace's
-- listed files (`POST /internal/slack/search`). Its own table, not a column
-- on slack_installations, so one Slack team can serve several workspaces
-- and one workspace can be searchable from several Slack teams.
CREATE TABLE IF NOT EXISTS slack_workspace_bindings (
  team_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  bound_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, workspace)
);

CREATE INDEX IF NOT EXISTS slack_workspace_bindings_workspace_idx
  ON slack_workspace_bindings (workspace);
