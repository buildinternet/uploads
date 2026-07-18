-- OAuth 2.1 authorization server (issue #224, Lane A): `jwt()` +
-- `oauthProvider()` plugins (see src/auth.ts). Paired with `jwks` /
-- oauthClient / oauthAccessToken / oauthRefreshToken / oauthConsent in
-- src/schema.ts. string[] columns are JSON text; timestamps are integer
-- epoch ms (Better Auth Drizzle / SQLite shape). Shape mirrors
-- ~/Code/sunny/apps/auth/src/schema.ts:239-336 and its paired migration
-- (apps/api/migrations/20260715064623_oauth_provider.sql).

CREATE TABLE jwks (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE oauth_client (
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
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_client_client_id ON oauth_client (client_id);

CREATE TABLE oauth_access_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  session_id TEXT REFERENCES session (id) ON DELETE SET NULL,
  refresh_id TEXT,
  user_id TEXT,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_access_token_token ON oauth_access_token (token);
CREATE INDEX idx_oauth_access_client_id ON oauth_access_token (client_id);
CREATE INDEX idx_oauth_access_session_id ON oauth_access_token (session_id);

CREATE TABLE oauth_refresh_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  session_id TEXT REFERENCES session (id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  revoked INTEGER, -- epoch ms; NULL = not revoked
  auth_time INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_refresh_token_token ON oauth_refresh_token (token);
CREATE INDEX idx_oauth_refresh_client_id ON oauth_refresh_token (client_id);
CREATE INDEX idx_oauth_refresh_session_id ON oauth_refresh_token (session_id);

CREATE TABLE oauth_consent (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_consent_user_client ON oauth_consent (user_id, client_id);
