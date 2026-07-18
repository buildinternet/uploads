-- Issue #251: the CLI's device-flow client becomes a managed oauth_client
-- registration instead of a string-allowlisted static id. The client_id stays
-- 'uploads-cli' so already-configured CLIs keep working. Shape mirrors the
-- admin panel's POST /internal/oauth-clients insert (public PKCE, no secret),
-- except: grant_types carries the RFC 8628 device grant, redirect_uris is
-- empty (device flow has no redirects), and metadata marks it official.
-- Idempotent: INSERT OR IGNORE keys off the client_id UNIQUE constraint.
-- skip_consent is seeded as 1: this is a first-party official client, and the
-- oauth-client-reaper (apps/auth/src/oauth-client-reaper.ts) exempts
-- skip_consent clients from its stale-client sweep. The device-authorization
-- plugin never consults skip_consent, so this is semantically a no-op for the
-- device flow itself but keeps this row from being reaped once it goes stale
-- (it has user_id NULL and will never accrue oauth_consent/oauth_access_token
-- rows, since device-flow logins issue Better Auth sessions, not tokens).
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
