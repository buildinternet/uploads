-- Newest-first scope reads (apps/api/src/pr-scope.ts: live links, Files
-- views, the pager) and the By repo list. Partial on purpose: only `gh.repo`
-- rows (one per GitHub-tagged object) pay the extra write, unlike the
-- all-rows value index dropped in 20260722190000. Serves
--   WHERE workspace = ? AND meta_key = 'gh.repo' AND meta_value = ?
--   ORDER BY updated_at DESC, object_key ASC
-- as a covering, in-order scan (no temp sort), so LIMIT stops early, and
-- the distinct-repo GROUP BY reads only this index. Queries must use the
-- literal 'gh.repo' (not a bound parameter) for SQLite to pick it.
CREATE INDEX IF NOT EXISTS file_metadata_gh_repo_recent_idx
  ON file_metadata (workspace, meta_value, updated_at DESC, object_key)
  WHERE meta_key = 'gh.repo';
