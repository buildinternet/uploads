-- Durable retry for the billing plan bridge (issue #451). When
-- `syncWorkspacePlan` (src/billing-bridge.ts) can't reach apps/api, it records
-- the affected organization here instead of dropping the change on the floor;
-- the cron drain (src/billing-outbox.ts) retries until it lands.
--
-- One row per organization, keyed by reference_id: a later failure for the
-- same org replaces the earlier one rather than queueing a second attempt.
--
-- Deliberately stores NO plan value. The drain recomputes the desired plan
-- from the `subscription` table at retry time, so a queued row can never
-- re-apply a plan that has since been superseded.
--
-- Paired with src/schema.ts — keep both in sync by hand (see the JSDoc there).

CREATE TABLE billing_plan_outbox (
  reference_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The drain's only query shape: rows that are due, oldest first.
CREATE INDEX billing_plan_outbox_next_attempt_at_idx
  ON billing_plan_outbox (next_attempt_at);
