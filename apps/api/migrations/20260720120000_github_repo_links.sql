-- Workspace<->repo binding for webhook-driven auto-promotion (phase 3). One
-- repo maps to at most one workspace; "first claim wins" is enforced at the
-- application layer via INSERT OR IGNORE (see github-repo-links.ts), not by
-- re-registration here.
CREATE TABLE github_repo_links (
  repo_full_name TEXT PRIMARY KEY,
  workspace_name TEXT NOT NULL,
  installation_id INTEGER,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX github_repo_links_workspace_idx
  ON github_repo_links (workspace_name);
