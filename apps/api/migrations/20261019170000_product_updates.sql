-- Per-user preference: email me product updates and announcements. Default 1
-- (on) for existing and new accounts; a person can untick it at sign-up
-- (apps/auth/src/product-updates.ts) or on /account/profile. Declared as a
-- better-auth additionalField in apps/auth/src/auth.ts so
-- /api/auth/update-user can write it. Nothing sends on its own: every
-- announcement is an operator-run campaign (apps/api/src/cli-upgrade-campaign.ts).
ALTER TABLE user ADD COLUMN notify_product_updates INTEGER NOT NULL DEFAULT 1;

-- One row per person a campaign has emailed, so running a campaign again only
-- reaches people it has not reached yet. `campaign` names the campaign and its
-- inputs, e.g. `cli-upgrade:0.59.0`.
CREATE TABLE IF NOT EXISTS email_campaign_sends (
  campaign  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  PRIMARY KEY (campaign, user_id)
);
