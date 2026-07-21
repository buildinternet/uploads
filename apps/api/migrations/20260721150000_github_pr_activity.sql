-- Per-PR media activity rollup (issue #338). One row per PR ref
-- ("owner/repo#n", lowercased); upserted whenever PR-tagged media is written
-- (promote or direct --pr attach, both via putObject). Powers the
-- "recent PRs with media" feed — not an event log, and media_count is a
-- monotonic events counter (overwrites re-count), not a distinct-file count.
CREATE TABLE github_pr_activity (
  ref TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  branch TEXT,
  workspace_name TEXT NOT NULL,
  media_count INTEGER NOT NULL DEFAULT 0,
  first_media_at TEXT NOT NULL,
  last_media_at TEXT NOT NULL
);

CREATE INDEX github_pr_activity_workspace_recent_idx
  ON github_pr_activity (workspace_name, last_media_at DESC);
