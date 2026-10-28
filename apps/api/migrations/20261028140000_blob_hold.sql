-- Current hold decision for a set of bytes, keyed by workspace and content
-- hash so a release follows the bytes across a rename, a promote, or an
-- attach. `file_events` stays the append-only history. This row is the
-- lookup gates and the held list use.
--
-- Backfill: an `ai.hold=approved` row with a `file_content_hash` becomes a
-- release event and a `released` projection, then the row is reset to
-- `pending`. A pending row with a hash becomes `held`. A row with no hash
-- is skipped and left as it is. After the migration, the skip count is
-- the number of `ai.hold=approved` rows still stored:
--   SELECT COUNT(*) FROM file_metadata
--   WHERE meta_key = 'ai.hold' AND meta_value = 'approved';
CREATE TABLE blob_hold (
  workspace TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  actor TEXT,
  at TEXT,
  PRIMARY KEY (workspace, content_sha256)
);

CREATE INDEX blob_hold_state_idx ON blob_hold (state, workspace);

INSERT INTO blob_hold (workspace, content_sha256, state, actor, at)
SELECT h.workspace, h.content_sha256, 'held', NULL, h.updated_at
FROM file_metadata m
JOIN file_content_hash h
  ON h.workspace = m.workspace AND h.object_key = m.object_key
WHERE m.meta_key = 'ai.hold' AND m.meta_value = 'pending'
ON CONFLICT(workspace, content_sha256) DO NOTHING;

INSERT INTO file_events (
  workspace, object_key, content_sha256, kind, action, actor, created_at
)
SELECT m.workspace, m.object_key, h.content_sha256, 'override', 'release',
  by_row.meta_value,
  COALESCE(at_row.meta_value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM file_metadata m
JOIN file_content_hash h
  ON h.workspace = m.workspace AND h.object_key = m.object_key
LEFT JOIN file_metadata by_row
  ON by_row.workspace = m.workspace AND by_row.object_key = m.object_key
  AND by_row.meta_key = 'ai.hold.by'
LEFT JOIN file_metadata at_row
  ON at_row.workspace = m.workspace AND at_row.object_key = m.object_key
  AND at_row.meta_key = 'ai.hold.at'
WHERE m.meta_key = 'ai.hold' AND m.meta_value = 'approved';

INSERT INTO blob_hold (workspace, content_sha256, state, actor, at)
SELECT h.workspace, h.content_sha256, 'released',
  MAX(by_row.meta_value),
  COALESCE(MAX(at_row.meta_value), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM file_metadata m
JOIN file_content_hash h
  ON h.workspace = m.workspace AND h.object_key = m.object_key
LEFT JOIN file_metadata by_row
  ON by_row.workspace = m.workspace AND by_row.object_key = m.object_key
  AND by_row.meta_key = 'ai.hold.by'
LEFT JOIN file_metadata at_row
  ON at_row.workspace = m.workspace AND at_row.object_key = m.object_key
  AND at_row.meta_key = 'ai.hold.at'
WHERE m.meta_key = 'ai.hold' AND m.meta_value = 'approved'
GROUP BY h.workspace, h.content_sha256
ON CONFLICT(workspace, content_sha256) DO UPDATE SET
  state = excluded.state,
  actor = excluded.actor,
  at = excluded.at;

UPDATE file_metadata
SET meta_value = 'pending'
WHERE meta_key = 'ai.hold' AND meta_value = 'approved'
  AND EXISTS (
    SELECT 1 FROM file_content_hash h
    WHERE h.workspace = file_metadata.workspace
      AND h.object_key = file_metadata.object_key
  );
