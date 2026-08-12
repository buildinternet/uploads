-- Randomized per-branch URL prefixes for private-repo attachments (#631).
-- One active id per (repo, branch); rotated rows are kept as tombstones.
-- branch = '' is the repo-level id (issue attachments, ingestion).
CREATE TABLE github_private_prefixes (
  repo_full_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  prefix_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  PRIMARY KEY (repo_full_name, branch, prefix_id)
);
CREATE UNIQUE INDEX github_private_prefixes_active_idx
  ON github_private_prefixes (repo_full_name, branch)
  WHERE rotated_at IS NULL;
CREATE INDEX github_private_prefixes_repo_idx
  ON github_private_prefixes (repo_full_name);
