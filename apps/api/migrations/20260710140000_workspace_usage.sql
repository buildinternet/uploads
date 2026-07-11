-- Per-workspace storage ledger (observe first; enforce budgets later).
-- Primary unit is the workspace/tenant — not the API token.
-- bytes/objects are net stored size under the workspace prefix;
-- uploads_in_period is a monthly upload counter (UTC calendar month).

CREATE TABLE workspace_usage (
  workspace TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  uploads_in_period INTEGER NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
