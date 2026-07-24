-- Reverse index from an object's stored-body SHA-256 to the object holding it,
-- so a content-identical re-upload can inherit the earlier object's derived
-- metadata (issue #479) on paths where the CLI sidecar cannot survive: the
-- hosted MCP (no local filesystem), CI steps, and second machines.
--
-- Deliberately NOT a `file_metadata` row. #511 established that `metadata`
-- means the user-facing queryable tag tier (`--meta`, `meta get`,
-- `find --meta`) while the R2 bag responds as `provenance`. `content-sha256`
-- is server-computed provenance, so storing it as a tag would push it back
-- into the tier #511 just separated -- a 64-char hash on every file's visible
-- tags, burning one of the 24 per-file key slots forever.
--
-- The primary key is (workspace, object_key), not the hash: an overwrite of the
-- same key must update that key's hash rather than accumulate a second row.
-- Many keys may share one hash, which is the whole point of the lookup index.
CREATE TABLE file_content_hash (
  workspace      TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (workspace, object_key)
);

-- Donor lookup: workspace + hash, ordered oldest-first for a deterministic
-- winner when several objects share bytes. `updated_at` and `object_key` are in
-- the index so that ordering is served without a table scan.
CREATE INDEX file_content_hash_lookup_idx
  ON file_content_hash (workspace, content_sha256, updated_at, object_key);
