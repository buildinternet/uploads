-- Supports daily observability retention purge on auth_enrollments
-- (expires_at < cutoff OR used_at < cutoff). The existing
-- auth_enrollments_code_idx leads with code_hash and cannot serve a pure
-- expires_at range scan.
CREATE INDEX IF NOT EXISTS auth_enrollments_expires_at_idx
  ON auth_enrollments (expires_at);
