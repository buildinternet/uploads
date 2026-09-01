-- Branch-rename aliases so promote can sweep a branch's whole name lineage (#920).
-- Rows are written by the CLI from the new branch's reflog; `source` is
-- 'cli-reflog' today and reserves room for a later webhook detector.
-- Workspace-scoped on purpose: a rename only ever widens which of the
-- CALLING workspace's own staged prefixes a promote sweeps.
CREATE TABLE github_branch_renames (
  workspace      TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,                  -- lowercased owner/name
  old_branch     TEXT NOT NULL COLLATE NOCASE,   -- stored verbatim (plain prefixes are case-preserving)
  new_branch     TEXT NOT NULL COLLATE NOCASE,
  source         TEXT NOT NULL,                  -- 'cli-reflog' today; 'webhook-push' reserved
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (workspace, repo_full_name, old_branch, new_branch)
);
CREATE INDEX github_branch_renames_new_idx
  ON github_branch_renames (workspace, repo_full_name, new_branch);
