-- Drop the account-wide weekly digest flags. They shipped in
-- 20261012140000 and were replaced about an hour later by the per-membership
-- flags in 20261012150000, which copied existing opt-ins across. Nothing
-- reads them, and the auth worker's Drizzle table stopped mapping them in
-- #1369.
--
-- Apply only after the auth worker from #1369 is live. An older worker
-- selects these columns by name and would fail user reads.

ALTER TABLE user DROP COLUMN notify_weekly_digest;
ALTER TABLE user DROP COLUMN notify_weekly_workspace_digest;
