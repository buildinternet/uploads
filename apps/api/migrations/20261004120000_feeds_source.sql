-- Who created a live feed row: 'comment' (GitHub comment sync) or 'user'
-- (web, CLI, MCP, plugin). NULL on rows created before this column. Set on
-- insert only: a reused scope keeps its first source. The per-workspace cap
-- (apps/api/src/feeds.ts) counts only 'user' repo-scoped rows (50); PR and
-- issue feeds are uncapped, so comment sync never falls back to /f/ links.
ALTER TABLE feeds ADD COLUMN source TEXT
  CHECK (source IS NULL OR source IN ('comment', 'user'));
