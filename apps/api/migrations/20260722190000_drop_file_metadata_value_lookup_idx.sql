-- file_metadata_value_lookup_idx (meta_key, meta_value, workspace, object_key)
-- existed solely to serve the staging reaper's cross-workspace scan
-- (WHERE meta_key = ? AND meta_value = ? ORDER BY workspace, object_key).
-- The reaper and its helper (findObjectsByMetadataAcrossWorkspaces) are gone.
--
-- Every remaining file_metadata lookup is workspace-scoped and already
-- served by file_metadata_lookup_idx (workspace, meta_key, meta_value), so
-- this index has no remaining query to serve. Every upload writes rows into
-- this table, so dropping the unused index removes write amplification from
-- the hottest write path in the system.

DROP INDEX IF EXISTS file_metadata_value_lookup_idx;
