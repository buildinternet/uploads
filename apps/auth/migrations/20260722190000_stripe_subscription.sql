-- Stripe phase 2: `@better-auth/stripe` schema (see
-- docs/superpowers/plans/2026-07-22-stripe-phase2-better-auth-plugin.md).
-- Dormant: the plugin only mounts when STRIPE_SECRET_KEY and
-- STRIPE_WEBHOOK_SECRET are both set (src/auth.ts), so this table stays
-- unwritten until then. Field set is mandated by the installed
-- @better-auth/stripe@1.6.23 plugin (dist/index.mjs `subscriptions` schema
-- export) — includes cancelAt/canceledAt/endedAt/billingInterval/
-- stripeScheduleId, which the phase-2 plan's example omits. Paired with
-- src/schema.ts — keep both in sync by hand (see the JSDoc there).

CREATE TABLE subscription (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'incomplete',
  period_start INTEGER,
  period_end INTEGER,
  trial_start INTEGER,
  trial_end INTEGER,
  cancel_at_period_end INTEGER DEFAULT FALSE,
  cancel_at INTEGER,
  canceled_at INTEGER,
  ended_at INTEGER,
  seats INTEGER,
  billing_interval TEXT,
  stripe_schedule_id TEXT
);

ALTER TABLE user ADD COLUMN stripe_customer_id TEXT;

ALTER TABLE organization ADD COLUMN stripe_customer_id TEXT;
