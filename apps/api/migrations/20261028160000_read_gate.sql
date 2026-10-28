-- Blocked public keys for the hosted read-gate Worker. One row per object
-- the hosted hosts must 404. The primary key is the lookup: lane plus the
-- key as it appears in the URL (workspace prefix included, no separate
-- workspace column). The Worker does not hash bytes and does not know
-- workspaces.
--
-- Backfill starts from held blobs (`blob_hold_state_idx`) and from
-- `ai.hold.moved` (`file_metadata_ai_idx`). Both are equality lookups.
-- Poster and PDF-preview keys share `posterKeyFor`'s path. A Slack PNG is
-- not its own object; the Worker reads it off the `/cdn-cgi/image/` URL.
CREATE TABLE read_gate (
  lane TEXT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (lane, object_key)
);

INSERT INTO read_gate (lane, object_key)
SELECT 'hosted', h.workspace || '/' || h.object_key
FROM blob_hold b
JOIN file_content_hash h
  ON h.workspace = b.workspace AND h.content_sha256 = b.content_sha256
JOIN file_metadata m
  ON m.workspace = h.workspace AND m.object_key = h.object_key
 AND m.meta_key = 'ai.hold'
 AND substr(m.meta_key, 1, 3) = 'ai.'
WHERE b.state = 'held'
ON CONFLICT(lane, object_key) DO NOTHING;

INSERT INTO read_gate (lane, object_key)
SELECT 'hosted', h.workspace || '/_internal/posters/' || h.object_key || '.jpg'
FROM blob_hold b
JOIN file_content_hash h
  ON h.workspace = b.workspace AND h.content_sha256 = b.content_sha256
JOIN file_metadata m
  ON m.workspace = h.workspace AND m.object_key = h.object_key
 AND m.meta_key = 'ai.hold'
 AND substr(m.meta_key, 1, 3) = 'ai.'
WHERE b.state = 'held'
ON CONFLICT(lane, object_key) DO NOTHING;

INSERT INTO read_gate (lane, object_key)
SELECT 'hosted', m.workspace || '/' || m.object_key
FROM file_metadata m
WHERE substr(m.meta_key, 1, 3) = 'ai.'
  AND m.meta_key = 'ai.hold.moved'
  AND m.meta_value = '1'
ON CONFLICT(lane, object_key) DO NOTHING;

INSERT INTO read_gate (lane, object_key)
SELECT 'hosted', m.workspace || '/_internal/posters/' || m.object_key || '.jpg'
FROM file_metadata m
WHERE substr(m.meta_key, 1, 3) = 'ai.'
  AND m.meta_key = 'ai.hold.moved'
  AND m.meta_value = '1'
ON CONFLICT(lane, object_key) DO NOTHING;
