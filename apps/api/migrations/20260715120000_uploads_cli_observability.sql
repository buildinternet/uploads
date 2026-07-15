-- CLI/MCP observability on the shared uploads D1 (same binding as auth/galleries).
-- Two tables, one database:
--   uploads_telemetry_events  — automatic command-name pings (high volume, no free text)
--   uploads_cli_reports       — explicit opt-in messages (+ optional R2 log attachment)
--
-- Why D1 (not KV): append + aggregate (counts by command/error/day). KV is a poor fit
-- for "list recent / group by". Report blobs stay in R2; only metadata is here.

CREATE TABLE uploads_telemetry_events (
  id          TEXT PRIMARY KEY NOT NULL,
  anon_id     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  surface     TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  agent_name  TEXT,
  command     TEXT NOT NULL,
  exit_code   INTEGER,
  duration_ms INTEGER,
  error_code  TEXT,
  cli_version TEXT NOT NULL,
  os          TEXT,
  arch        TEXT,
  runtime     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX uploads_telemetry_events_ts_idx ON uploads_telemetry_events (timestamp);
CREATE INDEX uploads_telemetry_events_cmd_idx ON uploads_telemetry_events (command);

CREATE TABLE uploads_cli_reports (
  id                   TEXT PRIMARY KEY NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  message              TEXT NOT NULL,
  type                 TEXT NOT NULL,
  contact              TEXT,
  surface              TEXT NOT NULL,
  client_kind          TEXT,
  anon_id              TEXT,
  cli_version          TEXT,
  os                   TEXT,
  arch                 TEXT,
  runtime              TEXT,
  command              TEXT,
  error_code           TEXT,
  attachment_key       TEXT,
  attachment_filename  TEXT,
  attachment_bytes     INTEGER
);

CREATE INDEX uploads_cli_reports_created_idx ON uploads_cli_reports (created_at);
