-- Per-user notification preference: message me in Slack when an upload is
-- held for review (apps/api/src/slack-hold-notify.ts). Default 1 (on); it
-- only does anything once the user connects Slack (slack_user_links), and
-- users turn it off on /account/profile. Declared as a better-auth
-- additionalField in apps/auth/src/auth.ts so /api/auth/update-user can
-- write it.
ALTER TABLE user ADD COLUMN notify_slack_holds INTEGER NOT NULL DEFAULT 1;
