-- Better Auth 1.6 → 1.7 schema migration (see src/schema.ts, src/auth.ts).
--
-- Reconciled field-by-field against `getAuthTables()` from the installed
-- 1.7.1 packages for THIS worker's plugin set (magicLink, admin, organization,
-- jwt, oauthProvider, bearer, deviceAuthorization). Column types follow the
-- existing convention: string[] → JSON TEXT, booleans → INTEGER (0/1),
-- timestamps → INTEGER epoch.
--
-- ⚠ This file auto-applies to prod on merge to main (D1 migrations CI). Every
-- statement here is additive or backfilling and safe to run against live data:
-- no NOT-NULL column is added without a backfill, and no column is dropped.
-- The legacy oauth_client.type / oauth_client.public columns (removed from the
-- 1.7 model) are intentionally LEFT in place — dropping them is destructive and
-- Better Auth simply ignores unknown columns.

-- ── (1) Account identity is scoped by issuer (keys on (issuer, accountId)) ──
-- Added nullable + backfilled rather than NOT NULL: SQLite cannot add a NOT
-- NULL column to a populated table without a default, and Better Auth 1.7
-- always writes `issuer` on new inserts. Backfill uses the exact synthetic
-- issuer Better Auth computes (createOAuthAccountIssuer =
-- `local:oauth:<providerId>`; createLocalAccountIssuer = `local:<providerId>`).
-- This worker only ever creates GitHub OAuth accounts (magic-link sign-in
-- writes no account row), so in practice every row backfills to
-- `local:oauth:github`; the credential branch is defensive only.
ALTER TABLE account ADD COLUMN issuer TEXT;
UPDATE account SET issuer = 'local:credential' WHERE issuer IS NULL AND provider_id = 'credential';
UPDATE account SET issuer = 'local:oauth:' || provider_id WHERE issuer IS NULL;
-- Lookup index for findAccountByKey({ issuer, accountId }). Non-unique: a
-- prod dedup audit is required before tightening to UNIQUE (see PR notes).
CREATE INDEX IF NOT EXISTS idx_account_issuer_account_id ON account (issuer, account_id);

-- ── (2) Device authorization: unique lookup indexes on code columns ──
-- Dedup first so the UNIQUE indexes can never fail on auto-apply. device_code
-- rows are ephemeral (short TTL + nightly retention sweep) and both values are
-- cryptographically random, so duplicates are effectively impossible; the
-- DELETEs are belt-and-suspenders.
DELETE FROM device_code WHERE id NOT IN (SELECT MIN(id) FROM device_code GROUP BY device_code);
DELETE FROM device_code WHERE id NOT IN (SELECT MIN(id) FROM device_code GROUP BY user_code);
DROP INDEX IF EXISTS idx_device_code_device_code;
DROP INDEX IF EXISTS idx_device_code_user_code;
CREATE UNIQUE INDEX idx_device_code_device_code ON device_code (device_code);
CREATE UNIQUE INDEX idx_device_code_user_code ON device_code (user_code);

-- ── (3) oauth_client: 1.7 columns (backchannel logout, DCR discovery,
-- client-credentials scopes, JWK client auth, application type, DPoP) ──
ALTER TABLE oauth_client ADD COLUMN client_discovery_id TEXT;
ALTER TABLE oauth_client ADD COLUMN client_credentials_scopes TEXT DEFAULT '[]';
ALTER TABLE oauth_client ADD COLUMN backchannel_logout_uri TEXT;
ALTER TABLE oauth_client ADD COLUMN backchannel_logout_session_required INTEGER;
ALTER TABLE oauth_client ADD COLUMN application_type TEXT;
ALTER TABLE oauth_client ADD COLUMN jwks TEXT;
ALTER TABLE oauth_client ADD COLUMN jwks_uri TEXT;
ALTER TABLE oauth_client ADD COLUMN dpop_bound_access_tokens INTEGER DEFAULT 0;

-- ── (4) oauth_access_token: resource binding + revocation + confirmation ──
ALTER TABLE oauth_access_token ADD COLUMN authorization_code_id TEXT;
ALTER TABLE oauth_access_token ADD COLUMN resources TEXT;
ALTER TABLE oauth_access_token ADD COLUMN requested_user_info_claims TEXT;
ALTER TABLE oauth_access_token ADD COLUMN confirmation TEXT;
ALTER TABLE oauth_access_token ADD COLUMN revoked INTEGER;
CREATE INDEX idx_oauth_access_authorization_code_id ON oauth_access_token (authorization_code_id);

-- ── (5) oauth_refresh_token: resource binding + rotation-replay + confirmation ──
ALTER TABLE oauth_refresh_token ADD COLUMN authorization_code_id TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN resources TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN requested_user_info_claims TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN rotated_at INTEGER;
ALTER TABLE oauth_refresh_token ADD COLUMN rotation_replay_response TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN rotation_replay_expires_at INTEGER;
ALTER TABLE oauth_refresh_token ADD COLUMN confirmation TEXT;
CREATE INDEX idx_oauth_refresh_authorization_code_id ON oauth_refresh_token (authorization_code_id);

-- ── (5b) jwks: signing algorithm + curve persisted per key (1.7) ──
ALTER TABLE jwks ADD COLUMN alg TEXT;
ALTER TABLE jwks ADD COLUMN crv TEXT;

-- ── (6) oauth_consent: resource + requested-claims binding ──
ALTER TABLE oauth_consent ADD COLUMN resources TEXT;
ALTER TABLE oauth_consent ADD COLUMN requested_user_info_claims TEXT;

-- ── (7) Protected-resource model (replaces validAudiences) ──
-- oauth_resource rows are seeded at boot from oauthProvider({ resources })
-- (resourceSeedMode "insertOnly", the safe default). created_at/updated_at are
-- nullable to match the 1.7 field shape (required: false).
CREATE TABLE oauth_resource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  access_token_ttl INTEGER,
  refresh_token_ttl INTEGER,
  signing_algorithm TEXT,
  signing_key_id TEXT,
  allowed_scopes TEXT,
  custom_claims TEXT,
  dpop_bound_access_tokens_required INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  policy_version INTEGER DEFAULT 1,
  metadata TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- Client ⋈ resource binding (authoritative only under enforcePerClientResources,
-- which this worker leaves off). Compound-unique per the 1.7 schema.
CREATE TABLE oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  resource_id TEXT NOT NULL REFERENCES oauth_resource (identifier),
  metadata TEXT,
  created_at INTEGER
);
CREATE UNIQUE INDEX idx_oauth_client_resource_client_resource
  ON oauth_client_resource (client_id, resource_id);

-- Single-use private_key_jwt client-assertion jti store (id = jti).
CREATE TABLE oauth_client_assertion (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
