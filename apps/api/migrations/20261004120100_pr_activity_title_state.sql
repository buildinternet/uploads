-- PR title and state on the rollup row, for the Files "By pull request"
-- list and its state filter. Written by the pull_request webhook (rows whose
-- repo is linked to the row's workspace only) and backfilled by
-- GET /v1/workspaces/:ws/pulls from resolveTitles. NULL until either runs.
-- The cursor index serves ORDER BY last_media_at DESC, ref ASC keyset pages.
ALTER TABLE github_pr_activity ADD COLUMN title TEXT;
ALTER TABLE github_pr_activity ADD COLUMN state TEXT;
CREATE INDEX github_pr_activity_workspace_cursor_idx
  ON github_pr_activity (workspace_name, last_media_at DESC, ref);
