-- Operator takedowns for hosted URLs (admin "Block URL"). Each row also has
-- a `read_gate` row, which is what the read-gate Worker checks. This table
-- records who blocked the key, when, and why, and keeps hold release, file
-- delete, and retention from dropping that gate row. Same key shape as
-- `read_gate`: lane plus the public object key.
CREATE TABLE url_block (
  lane TEXT NOT NULL,
  object_key TEXT NOT NULL,
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocked_by TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  PRIMARY KEY (lane, object_key)
);
