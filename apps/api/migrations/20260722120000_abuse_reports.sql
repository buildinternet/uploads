-- Public content reports (file page / API). Distinct from uploads_cli_reports
-- (CLI diagnostic messages). Operators get a best-effort email to abuse@;
-- rows are the durable audit trail when mail is down or rate-capped.

CREATE TABLE abuse_reports (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason     TEXT NOT NULL,
  message    TEXT,
  contact    TEXT,
  page_url   TEXT NOT NULL,
  workspace  TEXT,
  object_key TEXT,
  surface    TEXT NOT NULL
);

CREATE INDEX abuse_reports_created_idx ON abuse_reports (created_at);
CREATE INDEX abuse_reports_reason_created_idx ON abuse_reports (reason, created_at);
