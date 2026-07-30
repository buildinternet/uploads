-- Single-winner claim for delete usage accounting (issue #570).
-- Two concurrent DELETEs can both head an object and both record a negative
-- usage delta; INSERT OR IGNORE on (workspace, object_key) makes only the first
-- claimer debit the ledger. Cleared on a successful re-put of the same key so a
-- later delete can claim again.
CREATE TABLE delete_usage_claims (
  workspace  TEXT NOT NULL,
  object_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (workspace, object_key)
);
