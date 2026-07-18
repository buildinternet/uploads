-- Per-grant workspace choice (issue #231, auth side): stores a
-- multi-workspace user's last explicit workspace pick for the OAuth 2.1
-- authorization server. One row per user, keyed by user_id. Not a
-- @better-auth/oauth-provider table -- read/written by
-- src/workspace-choice.ts (see src/schema.ts:oauthWorkspaceChoice). Timestamps
-- are integer epoch ms, matching every other hand-synced table in this
-- schema (see migrations/20260717000000_oauth_provider.sql).

CREATE TABLE oauth_workspace_choice (
  user_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
