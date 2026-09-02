-- Server-written index of PR/issue attachments (one row per attachment
-- object), replacing the per-prefix R2 fan-out in gatherAttachments (#934).
-- NEVER written from client-supplied gh.* metadata: every row is derived
-- from the final object key plus the server-resolved target. `gh.*` is
-- client-settable (see file-metadata.ts) — a writer that shortcuts to
-- opts.metadata["gh.ref"] would let any files:write token render an
-- arbitrary object in a public PR comment.
CREATE TABLE github_attachments (
  workspace   TEXT NOT NULL,
  repo        TEXT NOT NULL,     -- lowercased owner/name
  kind        TEXT NOT NULL,     -- 'pull' | 'issues' (GhTarget.kind spelling,
                                 -- NOT the singular 'issue' used by gh.kind
                                 -- metadata) so the read query can bind
                                 -- target.kind directly
  num         INTEGER NOT NULL,
  object_key  TEXT NOT NULL,
  prefix_id   TEXT,              -- NULL = plain gh/ prefix; else 32-hex private id
  lane_id     TEXT,              -- storage lane the object was written to; NULL = active/origin
  source      TEXT NOT NULL,     -- put | attach | promote | adopt | backfill | reconcile
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  detached_at TEXT,              -- mirrors gh.detached; hidden from the render
  PRIMARY KEY (workspace, object_key)
);

-- The hot read. Partial so detached rows are never scanned, and
-- object_key-terminated so ORDER BY object_key needs no sort.
CREATE INDEX github_attachments_target_idx
  ON github_attachments (workspace, repo, kind, num, object_key)
  WHERE detached_at IS NULL;

-- Rotation sweep + repair: every row still pointing at a retired prefix id.
-- Partial: most rows are plain-key rows with prefix_id NULL, which this
-- index has no use for (rotation only ever looks up a specific non-NULL id).
CREATE INDEX github_attachments_prefix_idx
  ON github_attachments (workspace, prefix_id)
  WHERE prefix_id IS NOT NULL;

-- Ops/reconcile entry by coordinate when the workspace is resolved later.
CREATE INDEX github_attachments_repo_idx
  ON github_attachments (repo, kind, num);
