-- Issue #754 item 1: fold apps/auth's dedicated D1 database into this one.
--
-- This is a squash of every file in apps/auth/migrations/ (16 files, listed
-- below) into the schema shape they produce when applied in order against an
-- empty database. It does not replay each historical step (some add a column
-- then another migration backfills/dedupes/re-indexes it) — it just creates
-- the tables and indexes in their final form. apps/auth/migrations/ is the
-- historical record and keeps driving the OLD dedicated auth D1
-- (uploads-auth) until the data move happens; this file is additive only and
-- does not touch it.
--
-- Source files (apps/auth/migrations/):
--   20260712200000_better_auth_core.sql       user, session, account,
--                                              verification, rate_limit
--   20260712210000_admin_plugin.sql           session.impersonated_by
--   20260712220000_organization.sql           organization, member,
--                                              invitation, session.active_
--                                              organization_id
--   20260712230000_device_code.sql            device_code
--   20260714120000_cli_onboarded_at.sql       user.cli_onboarded_at (+ backfill,
--                                              not replayed — no rows exist yet)
--   20260717000000_oauth_provider.sql         jwks, oauth_client,
--                                              oauth_access_token,
--                                              oauth_refresh_token, oauth_consent
--   20260718000000_oauth_workspace_choice.sql oauth_workspace_choice
--   20260719000000_seed_cli_oauth_client.sql  seed row in oauth_client (replayed
--                                              below, still INSERT OR IGNORE)
--   20260721160000_invitation_org_status_idx.sql
--   20260722180000_retention_expires_at_idx.sql
--   20260722190000_stripe_subscription.sql    subscription,
--                                              user/organization.stripe_customer_id
--   20260723120000_session_cli_version.sql    session.cli_version
--   20260723150000_billing_plan_outbox.sql    billing_plan_outbox
--   20260728120000_created_at_indexes.sql
--   20260731120000_github_identity.sql        github_identity
--   20260821120000_better_auth_1_7.sql        account.issuer + unique index,
--                                              device_code unique indexes,
--                                              oauth_client/access_token/
--                                              refresh_token/jwks/consent 1.7
--                                              columns, oauth_resource,
--                                              oauth_client_resource,
--                                              oauth_client_assertion
--
-- Schema-collision check (done by hand against apps/api/migrations/*.sql, see
-- .context/754-auth-d1-merge-plan.md): no table or index name below collides
-- with an existing apps/api table/index. Every statement is guarded with
-- IF NOT EXISTS so this is safe to run twice and safe to run against a
-- database that already has these tables (e.g. a local D1 that previously
-- ran apps/auth's own migrations against the same file, or a re-run after a
-- partial apply).

CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  role TEXT,
  banned INTEGER,
  ban_reason TEXT,
  ban_expires INTEGER,
  cli_onboarded_at INTEGER,
  stripe_customer_id TEXT
);
CREATE INDEX IF NOT EXISTS user_created_at_idx ON user (created_at);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  impersonated_by TEXT,
  active_organization_id TEXT,
  cli_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session (user_id);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  id_token TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  issuer TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_user_id ON account (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_issuer_account_id ON account (issuer, account_id);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification (identifier);
CREATE INDEX IF NOT EXISTS idx_verification_expires_at ON verification (expires_at);

CREATE TABLE IF NOT EXISTS rate_limit (
  id TEXT PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  stripe_customer_id TEXT
);
CREATE INDEX IF NOT EXISTS organization_created_at_idx ON organization (created_at);

CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_organization_id ON member (organization_id);
CREATE INDEX IF NOT EXISTS idx_member_user_id ON member (user_id);

CREATE TABLE IF NOT EXISTS invitation (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitation_organization_id ON invitation (organization_id);
CREATE INDEX IF NOT EXISTS idx_invitation_organization_status ON invitation (organization_id, status);

CREATE TABLE IF NOT EXISTS device_code (
  id TEXT PRIMARY KEY NOT NULL,
  device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_polled_at INTEGER,
  polling_interval INTEGER,
  client_id TEXT,
  scope TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_code_device_code ON device_code (device_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_code_user_code ON device_code (user_code);
CREATE INDEX IF NOT EXISTS idx_device_code_expires_at ON device_code (expires_at);

CREATE TABLE IF NOT EXISTS jwks (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  alg TEXT,
  crv TEXT
);

CREATE TABLE IF NOT EXISTS oauth_client (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  name TEXT,
  icon TEXT,
  uri TEXT,
  redirect_uris TEXT NOT NULL,
  post_logout_redirect_uris TEXT,
  scopes TEXT NOT NULL,
  grant_types TEXT,
  response_types TEXT,
  contacts TEXT,
  token_endpoint_auth_method TEXT,
  type TEXT,
  public INTEGER,
  require_pkce INTEGER,
  disabled INTEGER,
  skip_consent INTEGER,
  enable_end_session INTEGER,
  subject_type TEXT,
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  user_id TEXT,
  reference_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  client_discovery_id TEXT,
  client_credentials_scopes TEXT DEFAULT '[]',
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required INTEGER,
  application_type TEXT,
  jwks TEXT,
  jwks_uri TEXT,
  dpop_bound_access_tokens INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oauth_client_client_id ON oauth_client (client_id);

CREATE TABLE IF NOT EXISTS oauth_access_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  session_id TEXT REFERENCES session (id) ON DELETE SET NULL,
  refresh_id TEXT,
  user_id TEXT,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  confirmation TEXT,
  revoked INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_token ON oauth_access_token (token);
CREATE INDEX IF NOT EXISTS idx_oauth_access_client_id ON oauth_access_token (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_session_id ON oauth_access_token (session_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_authorization_code_id ON oauth_access_token (authorization_code_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  session_id TEXT REFERENCES session (id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  revoked INTEGER,
  auth_time INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  rotated_at INTEGER,
  rotation_replay_response TEXT,
  rotation_replay_expires_at INTEGER,
  confirmation TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_token ON oauth_refresh_token (token);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client_id ON oauth_refresh_token (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_session_id ON oauth_refresh_token (session_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_authorization_code_id ON oauth_refresh_token (authorization_code_id);

CREATE TABLE IF NOT EXISTS oauth_consent (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resources TEXT,
  requested_user_info_claims TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_user_client ON oauth_consent (user_id, client_id);

CREATE TABLE IF NOT EXISTS oauth_resource (
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

CREATE TABLE IF NOT EXISTS oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  resource_id TEXT NOT NULL REFERENCES oauth_resource (identifier),
  metadata TEXT,
  created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_client_resource_client_resource
  ON oauth_client_resource (client_id, resource_id);

CREATE TABLE IF NOT EXISTS oauth_client_assertion (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_workspace_choice (
  user_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'incomplete',
  period_start INTEGER,
  period_end INTEGER,
  trial_start INTEGER,
  trial_end INTEGER,
  cancel_at_period_end INTEGER DEFAULT FALSE,
  cancel_at INTEGER,
  canceled_at INTEGER,
  ended_at INTEGER,
  seats INTEGER,
  billing_interval TEXT,
  stripe_schedule_id TEXT
);

CREATE TABLE IF NOT EXISTS billing_plan_outbox (
  reference_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_plan_outbox_next_attempt_at_idx ON billing_plan_outbox (next_attempt_at);

CREATE TABLE IF NOT EXISTS github_identity (
  account_id TEXT PRIMARY KEY NOT NULL,
  login TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed row from apps/auth/migrations/20260719000000_seed_cli_oauth_client.sql
-- (issue #251) — the CLI device-flow client as a managed oauth_client
-- registration. INSERT OR IGNORE keys off the client_id UNIQUE constraint, so
-- this is a no-op if the row already exists (e.g. it was carried over by the
-- prod data-move rather than created fresh here).
INSERT OR IGNORE INTO oauth_client (
  id, client_id, client_secret, name, redirect_uris, scopes,
  grant_types, response_types, token_endpoint_auth_method, type,
  public, require_pkce, disabled, skip_consent, user_id, metadata,
  created_at, updated_at
) VALUES (
  'oc_uploads_cli_seed',
  'uploads-cli',
  NULL,
  'Uploads CLI',
  '[]',
  '["files:read","files:write","files:delete"]',
  '["urn:ietf:params:oauth:grant-type:device_code"]',
  '[]',
  'none',
  'web',
  1, 1, 0, 1,
  NULL,
  '{"official":true}',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
