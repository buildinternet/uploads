-- Per-user notification preference: email me when someone joins a workspace
-- I administer. Default 1 (on) so existing admins keep getting notified; users
-- opt out on /account/profile. Declared as a better-auth additionalField in
-- apps/auth/src/auth.ts so /api/auth/update-user can write it.
ALTER TABLE user ADD COLUMN notify_member_join INTEGER NOT NULL DEFAULT 1;
