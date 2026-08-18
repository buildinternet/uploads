-- Ledger of link-adopted files (issue #709, follow-up to #701/#707). One row
-- per (repo, kind, num, source_key) — the resolved workspace key a pasted
-- uploads.sh link resolved to, scoped to the PR/issue it was adopted into.
-- detached_at NULL == currently referenced by `source` (the body or the
-- specific comment it was last seen in).
CREATE TABLE github_adopted_links (
  repo        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  num         INTEGER NOT NULL,
  source_key  TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  detached_at TEXT,
  PRIMARY KEY (repo, kind, num, source_key)
);
CREATE INDEX github_adopted_links_source_idx ON github_adopted_links (repo, kind, num, source);
CREATE INDEX github_adopted_links_target_idx ON github_adopted_links (repo, kind, num, detached_at);
