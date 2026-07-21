-- Hot-path D1 indexes (rows-read):
-- 1) Cross-workspace metadata (staging reaper: gh.kind=branch). Existing
--    file_metadata_lookup_idx leads with workspace, so it cannot serve this.
-- 2) Ban-time revoke by minting user (revokeTokensForMintingUser).

CREATE INDEX IF NOT EXISTS file_metadata_value_lookup_idx
  ON file_metadata (meta_key, meta_value);

CREATE INDEX IF NOT EXISTS auth_tokens_minting_user_idx
  ON auth_tokens (minting_user_id)
  WHERE minting_user_id IS NOT NULL AND revoked_at IS NULL;
