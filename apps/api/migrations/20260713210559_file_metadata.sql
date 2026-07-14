CREATE TABLE file_metadata (
  workspace  TEXT NOT NULL,
  object_key TEXT NOT NULL,
  meta_key   TEXT NOT NULL,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, object_key, meta_key)
);
CREATE INDEX file_metadata_lookup_idx
  ON file_metadata (workspace, meta_key, meta_value);
