-- Operator classifier views (apps/api/src/classifier-admin.ts): global
-- counts by `ai.*` key and value, and the flagged-file list. Those reads
-- are cross-workspace, so file_metadata_lookup_idx (workspace first)
-- cannot serve them and they would scan the whole table.
--
-- Partial on purpose, like file_metadata_gh_repo_recent_idx: only `ai.*`
-- rows (written for allowlisted workspaces) pay the extra write, not every
-- upload's metadata. Queries must repeat the literal predicate
-- `substr(meta_key, 1, 3) = 'ai.'` for SQLite to pick the index.
CREATE INDEX IF NOT EXISTS file_metadata_ai_idx
  ON file_metadata (meta_key, meta_value, workspace, object_key, updated_at)
  WHERE substr(meta_key, 1, 3) = 'ai.';
