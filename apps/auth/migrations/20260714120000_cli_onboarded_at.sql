-- Sticky "completed CLI login once" (schema: user.cliOnboardedAt).
-- Set on CLI device-flow session create; backfill from existing CLI sessions.

ALTER TABLE user ADD COLUMN cli_onboarded_at INTEGER;

UPDATE user
SET cli_onboarded_at = (
  SELECT MIN(s.created_at)
  FROM session s
  WHERE s.user_id = user.id
    AND s.user_agent LIKE '%@buildinternet/uploads%'
)
WHERE EXISTS (
  SELECT 1
  FROM session s
  WHERE s.user_id = user.id
    AND s.user_agent LIKE '%@buildinternet/uploads%'
);
