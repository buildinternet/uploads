-- Better Auth `@better-auth/api-key` plugin (user-owned developer keys).
-- Field set reconciled against `@better-auth/api-key@1.6.23`'s `apiKeySchema`
-- (`configId` + `referenceId`, no legacy `userId` column). Table name is the
-- plugin's model name `apikey`. Paired with src/schema.ts — keep both in
-- sync by hand (see the JSDoc there).
--
-- `idx_apikey_expires_at` is ours (not required by the plugin) so the nightly
-- retention sweep can delete expired rows without a full table scan.
CREATE TABLE apikey (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL DEFAULT 'default',
  name TEXT,
  start TEXT,
  prefix TEXT,
  key TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  refill_interval INTEGER,
  refill_amount INTEGER,
  last_refill_at INTEGER,
  enabled INTEGER DEFAULT TRUE,
  rate_limit_enabled INTEGER DEFAULT TRUE,
  rate_limit_time_window INTEGER,
  rate_limit_max INTEGER,
  request_count INTEGER DEFAULT 0,
  remaining INTEGER,
  last_request INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  permissions TEXT,
  metadata TEXT
);

CREATE INDEX idx_apikey_config_id ON apikey (config_id);
CREATE INDEX idx_apikey_reference_id ON apikey (reference_id);
CREATE INDEX idx_apikey_key ON apikey (key);
CREATE INDEX idx_apikey_expires_at ON apikey (expires_at);
