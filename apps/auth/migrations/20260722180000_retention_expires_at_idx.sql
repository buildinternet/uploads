-- Nightly runAuthRetentionSweep: WHERE expires_at < ? LIMIT 500
-- (apps/auth/src/retention-sweep.ts). Without these indexes each batch is a
-- full table scan (D1 rows-read).

CREATE INDEX IF NOT EXISTS idx_verification_expires_at
  ON verification (expires_at);

CREATE INDEX IF NOT EXISTS idx_device_code_expires_at
  ON device_code (expires_at);
