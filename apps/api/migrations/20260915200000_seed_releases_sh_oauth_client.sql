-- Official public PKCE client for releases.sh (authorization_code + refresh_token).
-- client_id is the stable literal `releases-sh`, like `uploads-cli` — not a UUID.
-- INSERT OR IGNORE keys off the client_id UNIQUE constraint, so this is a
-- no-op if the row already exists.
--
-- Third-party: skip_consent stays 0 (user must consent). Official so the
-- stale-client reaper never sweeps it (metadata.official; skip_consent is
-- not the exemption here).
--
-- Scopes: files:read plus offline_access so the refresh_token grant can
-- actually mint refresh tokens (issue #911).
--
-- Redirects: https is allowed for any host, including releases.localhost.
-- http is allowed only for true loopback (localhost / 127.0.0.1). No :8788
-- callbacks — those are not registered.
--
-- Icon: the live releases.sh mark (Connected apps shows clientIcon when it
-- is an https URL). Do not use /favicon.svg — that path 404s.
INSERT OR IGNORE INTO oauth_client (
  id, client_id, client_secret, name, icon, uri, redirect_uris, scopes,
  grant_types, response_types, token_endpoint_auth_method, type,
  public, require_pkce, disabled, skip_consent, user_id, metadata,
  created_at, updated_at
) VALUES (
  'oc_releases_sh_seed',
  'releases-sh',
  NULL,
  'Releases',
  'https://releases.sh/icon.svg',
  'https://releases.sh',
  '["https://releases.sh/integrations/uploads/callback","https://releases.localhost/integrations/uploads/callback","http://localhost:3000/integrations/uploads/callback","http://127.0.0.1:3000/integrations/uploads/callback"]',
  '["files:read","offline_access"]',
  '["authorization_code","refresh_token"]',
  '["code"]',
  'none',
  'web',
  1, 1, 0, 0,
  NULL,
  '{"official":true}',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
