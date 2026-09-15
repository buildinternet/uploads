-- Capability-URL repo change feeds. A feed stores a query (gh.repo + optional
-- path), not a curated item list. The public page runs that query at view time.
-- Soft-deleted rows do not count toward the unique (workspace, repo, path) slot.

CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL CHECK (length(trim(repo)) BETWEEN 3 AND 200),
  path TEXT NOT NULL DEFAULT '' CHECK (length(path) <= 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX feeds_workspace_created_idx
  ON feeds (workspace, created_at, id);

CREATE UNIQUE INDEX feeds_workspace_repo_path_live
  ON feeds (workspace, repo, path)
  WHERE deleted_at IS NULL;
