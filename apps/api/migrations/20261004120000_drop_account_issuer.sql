-- Better Auth 1.7.0–1.7.2 keyed accounts by (issuer, account_id) and wrote a
-- synthetic issuer on every row. 1.7.3 went back to (provider_id, account_id)
-- and stopped writing it, and the auth worker's Drizzle table no longer maps
-- the column. Drop the unique index first: SQLite refuses to drop a column
-- that an index still references.
--
-- Apply only after the worker without `issuer` in its Drizzle table is live.
-- An older worker selects the column by name and would fail account reads.
--
-- Rolling back to Better Auth 1.7.1 after this needs the column re-added and
-- `issuer = 'local:oauth:github'` backfilled on GitHub rows.

DROP INDEX IF EXISTS idx_account_issuer_account_id;
ALTER TABLE account DROP COLUMN issuer;
