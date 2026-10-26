-- Which client (and version) each credential last used, per workspace, so an
-- operator can see who is on an outdated CLI or MCP. One row per
-- (workspace, principal, surface); the writer (src/client-activity.ts)
-- upserts at most once per CLIENT_ACTIVITY_TOUCH_SECONDS per row.
--
-- principal: `token:<auth_tokens.id>` | `legacy:<token hash prefix>` |
--            `user:<better-auth user id>` (hosted MCP over OAuth)
-- surface:   `cli` | `mcp-local` (stdio `uploads mcp`) | `mcp-remote`
--            (agents.uploads.sh)
-- client_name/client_version: `@buildinternet/uploads` + its version for the
--            CLI and local MCP; the MCP host's clientInfo for mcp-remote.
CREATE TABLE IF NOT EXISTS client_activity (
  workspace       TEXT NOT NULL,
  principal       TEXT NOT NULL,
  surface         TEXT NOT NULL,
  user_id         TEXT,
  token_id        TEXT,
  client_name     TEXT,
  client_version  TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  PRIMARY KEY (workspace, principal, surface)
);

CREATE INDEX IF NOT EXISTS client_activity_last_seen_idx
  ON client_activity (last_seen_at DESC);
