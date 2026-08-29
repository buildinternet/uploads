-- Per-user notification preference: email me when a workspace I administer
-- nears its usage limit (50/90/100% of storage or monthly uploads). Default 1
-- (on) so existing admins get alerted; users opt out on /account/profile.
-- Declared as a better-auth additionalField in apps/auth/src/auth.ts so
-- /api/auth/update-user can write it.
ALTER TABLE user ADD COLUMN notify_usage_limits INTEGER NOT NULL DEFAULT 1;
