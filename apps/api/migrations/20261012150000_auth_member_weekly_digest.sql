-- Per-membership weekly digest preferences. Both default off: a missing
-- opt-in must not start mail. The live flags are these columns. The
-- account-wide columns on `user` (20261012140000) stay in place so a worker
-- from that release can still read them during rollout. New mail does not
-- read them.
--
-- Existing opt-ins are copied onto current memberships:
--   notify_weekly_digest copies onto every membership.
--   notify_weekly_workspace_digest copies onto admin and owner memberships
--   only. A member role cannot receive the admin pulse, and copying the
--   flag onto that row would start mail later if the person is promoted.

ALTER TABLE member ADD COLUMN notify_weekly_digest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member ADD COLUMN notify_weekly_workspace_digest INTEGER NOT NULL DEFAULT 0;

UPDATE member
SET notify_weekly_digest = 1
WHERE user_id IN (SELECT id FROM user WHERE notify_weekly_digest = 1);

UPDATE member
SET notify_weekly_workspace_digest = 1
WHERE role IN ('admin', 'owner')
  AND user_id IN (SELECT id FROM user WHERE notify_weekly_workspace_digest = 1);
