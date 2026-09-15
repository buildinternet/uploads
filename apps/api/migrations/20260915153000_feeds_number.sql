-- Optional PR/issue scope on a change feed. number=0 means repo-wide (same
-- as v1). Kind is display-only (`pull` / `issue` / ''); the live find uses
-- gh.repo + gh.number. GitHub numbers are unique per repo, so kind is not
-- part of the unique slot.

ALTER TABLE feeds ADD COLUMN number INTEGER NOT NULL DEFAULT 0
  CHECK (number >= 0 AND number <= 2147483647);

ALTER TABLE feeds ADD COLUMN kind TEXT NOT NULL DEFAULT ''
  CHECK (kind IN ('', 'pull', 'issue'));

DROP INDEX feeds_workspace_repo_path_live;

CREATE UNIQUE INDEX feeds_workspace_repo_path_number_live
  ON feeds (workspace, repo, path, number)
  WHERE deleted_at IS NULL;
