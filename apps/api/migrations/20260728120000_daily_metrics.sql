-- Per-day adoption counters (operator metrics surface). Describes CHANGE OVER
-- TIME only: `workspace_usage` remains the source of truth for current
-- absolute stored bytes/objects. `count`/`bytes` are always non-negative — a
-- delete records positive bytes under the `delete` metric rather than negative
-- bytes under `upload`, so net change is `upload.bytes - delete.bytes` at read
-- time.
--
-- Every recorded event writes TWO rows: the per-workspace row and a
-- platform-total row (`workspace = ''`). The platform row exists so the
-- headline trend charts cost exactly one index entry per day in the window
-- instead of one per (workspace, day) — D1 bills rows read, and that query
-- runs on every page load. D1 has a single writer per database, so the
-- "hot row" contention concern of a multi-master store does not apply.
--
-- Key order is (metric, day, workspace) so one metric's day range is
-- contiguous. Retention is unbounded: every query is windowed by `day >= ?`,
-- so old rows are never scanned and rolling them up would buy nothing.

CREATE TABLE daily_metrics (
  metric    TEXT NOT NULL,
  day       TEXT NOT NULL,               -- 'YYYY-MM-DD', UTC
  workspace TEXT NOT NULL DEFAULT '',    -- '' = the platform-total row
  count     INTEGER NOT NULL DEFAULT 0,
  bytes     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, day, workspace)
);

-- Covering: carries count/bytes so grouped per-workspace scans are served
-- entirely from the index with no per-row table lookup. Same reasoning as
-- 20260722180000_file_metadata_value_covering_idx.sql.
CREATE INDEX daily_metrics_window_idx
  ON daily_metrics (metric, day, workspace, count, bytes);

-- Partial + covering: the headline trend series reads exactly one entry per
-- day in the window. Partial-index precedent: auth_tokens_minting_user_idx.
CREATE INDEX daily_metrics_platform_idx
  ON daily_metrics (metric, day, count, bytes)
  WHERE workspace = '';
