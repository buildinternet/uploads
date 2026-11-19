-- Feedback reports (issue #1419 follow-up): who sent it and whether we may
-- follow up. `workspace` / `user_id` are set only for reports relayed by the
-- hosted MCP over the service binding (never trusted from public callers).
ALTER TABLE uploads_cli_reports ADD COLUMN workspace TEXT;
ALTER TABLE uploads_cli_reports ADD COLUMN user_id TEXT;
ALTER TABLE uploads_cli_reports ADD COLUMN follow_up_ok INTEGER;
