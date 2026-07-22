-- Covering index for cross-workspace (meta_key, meta_value) lookups that also
-- ORDER BY workspace, object_key LIMIT N (staging reaper). The prior
-- (meta_key, meta_value) index forced a full match-set sort before LIMIT,
-- billing rows-read proportional to all branch-staged metadata rows.

DROP INDEX IF EXISTS file_metadata_value_lookup_idx;

CREATE INDEX IF NOT EXISTS file_metadata_value_lookup_idx
  ON file_metadata (meta_key, meta_value, workspace, object_key);
