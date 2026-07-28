-- Signup-by-day aggregation for the operator metrics surface. Without these
-- the windowed GROUP BY scans every user/organization row, and D1 bills rows
-- read. `created_at` is epoch SECONDS (drizzle `mode: "timestamp"`), not
-- milliseconds.

CREATE INDEX IF NOT EXISTS user_created_at_idx ON user (created_at);
CREATE INDEX IF NOT EXISTS organization_created_at_idx ON organization (created_at);
