-- Supports daily observability retention purge on auth_enrollments
-- (expires_at < cutoff OR (used_at IS NOT NULL AND used_at < cutoff)).
-- The existing auth_enrollments_code_idx leads with code_hash and cannot
-- serve a pure expires_at / used_at range scan.
CREATE INDEX IF NOT EXISTS auth_enrollments_expires_at_idx
  ON auth_enrollments (expires_at);

-- Partial index: only used rows (used_at non-null), so the second OR-leg of
-- the purge predicate can range-scan without reading unused enrollments.
CREATE INDEX IF NOT EXISTS auth_enrollments_used_at_idx
  ON auth_enrollments (used_at)
  WHERE used_at IS NOT NULL;
