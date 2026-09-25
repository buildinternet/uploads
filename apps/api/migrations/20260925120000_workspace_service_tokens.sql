-- Issue #1026: workspace-owned service tokens for CI and bots.
--
-- `owner` says who a token belongs to. 'member' covers every row that existed
-- before this migration: session mints (minting_user_id set), enrollment-code
-- exchanges and pre-tracking rows (minting_user_id NULL). 'workspace' rows are
-- service tokens minted by a workspace admin from workspace settings. They
-- always have minting_user_id NULL, so the member-lifecycle revocations in
-- apps/auth/src/member-tokens.ts (which match on minting_user_id) never touch
-- them, and their `label` is the uploader attribution.
--
-- `created_by_user_id` is audit only: the admin who minted a service token.
-- It never grants or revokes anything.
ALTER TABLE auth_tokens ADD COLUMN owner TEXT NOT NULL DEFAULT 'member';
ALTER TABLE auth_tokens ADD COLUMN created_by_user_id TEXT;
