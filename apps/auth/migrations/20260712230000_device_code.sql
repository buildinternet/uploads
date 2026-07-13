-- Phase 4: `deviceAuthorization` plugin store — the OAuth 2.0 Device
-- Authorization Grant (RFC 8628) pending-request table backing `uploads login`
-- from the CLI (see src/auth.ts, plan D5). Paired with the `deviceCode` table
-- in src/schema.ts.
--
-- Field set is mandated by the plugin (its schema.mjs): note there are NO
-- created_at/updated_at columns. Like `rate_limit`, the SQL name is snake_case
-- but the drizzle-adapter schema KEY must stay the camelCase model name
-- `deviceCode`. Reconciled against `npx @better-auth/cli generate` for the
-- device-authorization plugin and ~/Code/releases/workers/api/migrations/
-- 20260605000000_add_device_code.sql.
CREATE TABLE device_code (
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

CREATE INDEX idx_device_code_device_code ON device_code (device_code);
CREATE INDEX idx_device_code_user_code ON device_code (user_code);
