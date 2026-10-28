-- Append-only log of classifier attempts and member hold overrides
-- (issue #1136, storage redesign step 1).
--
-- Rows are inserted and never updated. An overwrite clears the current
-- `ai.*` rows and then appends another event; it does not delete the
-- earlier ones. Object delete and retention leave the log in place, so a
-- release cannot be erased by deleting the file. Workspace teardown
-- removes the workspace's rows.
--
-- `content_sha256` is the bytes this event describes. It is the future
-- blob id for content-addressed storage and is not a foreign key. An
-- override's hash is never null: it is the object's `content-sha256`, or
-- the hash of the body restored from the held bucket. An override applies
-- to a key only while that key's current bytes hash to `content_sha256`.
-- A different hash is a different set of bytes and the override is ignored.
--
-- `kind` is classified, reused_exact, reused_perceptual, skipped, failed,
-- or override. `action` is release or hold, and only on an override.
-- Safety columns are the answers in force for that attempt. They are a
-- copy. Nothing here writes `file_metadata`.
CREATE TABLE file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_sha256 TEXT,
  kind TEXT NOT NULL,
  classifier_version TEXT,
  model TEXT,
  reason TEXT,
  action TEXT,
  actor TEXT,
  rating TEXT,
  rating_confidence TEXT,
  content_flag TEXT,
  content_confidence TEXT,
  secret TEXT,
  secret_confidence TEXT,
  pii TEXT,
  pii_confidence TEXT,
  created_at TEXT NOT NULL
);

-- History of one key, oldest first. Also serves the latest-override read.
CREATE INDEX file_events_key_idx ON file_events (workspace, object_key, id);

-- Future blob lookup: every event that described these bytes.
CREATE INDEX file_events_hash_idx ON file_events (workspace, content_sha256, id);
