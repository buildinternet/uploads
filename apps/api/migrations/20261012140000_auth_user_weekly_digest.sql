-- Per-user weekly digest preferences. Both default off: a missing opt-in
-- must not start mail. Declared as better-auth additionalFields in
-- apps/auth/src/auth.ts so /api/auth/update-user can write them.
-- notify_weekly_digest: activity in workspaces the user belongs to.
-- notify_weekly_workspace_digest: workspace usage and member activity for
-- workspaces the user administers (admin or owner).
ALTER TABLE user ADD COLUMN notify_weekly_digest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN notify_weekly_workspace_digest INTEGER NOT NULL DEFAULT 0;
