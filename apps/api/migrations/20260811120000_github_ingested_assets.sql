-- Ledger of GitHub-native user-attachments mirrored into workspaces
-- (spec docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md).
-- One row per (repo, asset); detached_at NULL == currently referenced.
CREATE TABLE github_ingested_assets (
  repo        TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  num         INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  detached_at TEXT,
  PRIMARY KEY (repo, asset_id)
);
CREATE INDEX github_ingested_assets_source_idx ON github_ingested_assets (repo, source);
