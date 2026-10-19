-- Per-user notification preference: email me when an upload is held for
-- review (apps/api/src/hold-email-notify.ts). Default 0 (off), since holds
-- can be noisy; users turn it on on /account/profile, next to the Slack
-- toggle (`notify_slack_holds`). Declared as a better-auth additionalField
-- in apps/auth/src/auth.ts so /api/auth/update-user can write it.
ALTER TABLE user ADD COLUMN notify_email_holds INTEGER NOT NULL DEFAULT 0;
