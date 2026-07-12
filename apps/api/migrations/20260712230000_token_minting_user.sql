-- Phase 4 (plan D5): record which Better Auth user minted a workspace token.
-- Populated by POST /v1/tokens (device-flow / session mints); NULL for tokens
-- created before this migration and for the enrollment-code path (which has no
-- user identity). Nullable so it never blocks the existing exchange flow.
-- Enables future revocation-by-user and per-user token caps.
ALTER TABLE auth_tokens ADD COLUMN minting_user_id TEXT;
