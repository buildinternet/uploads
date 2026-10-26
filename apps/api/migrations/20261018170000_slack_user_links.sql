-- Linking Slack users to uploads.sh accounts (apps/slack + /me/slack/*).
--
-- slack_link_tickets: single-use handoffs. uploads-slack mints one when a
-- user who isn't linked yet opens the app's Home tab; the "Connect" button
-- carries the raw ticket to uploads.sh/slack/connect, and the signed-in
-- user's POST /me/slack/connect/:ticket consumes it. Only the SHA-256 of the
-- ticket (base64url) is stored, so a database read can't replay one.
-- slack_user_name is the Slack display name at mint time, shown on the
-- confirm page so a user can tell when a forwarded link would connect
-- someone else's Slack account to theirs.
CREATE TABLE IF NOT EXISTS slack_link_tickets (
  ticket_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT,
  slack_user_id TEXT NOT NULL,
  slack_user_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS slack_link_tickets_expires_idx
  ON slack_link_tickets (expires_at);

-- One uploads.sh account per Slack user per workspace. user_id is the
-- Better Auth user id; user_email is a display snapshot taken at link time.
CREATE TABLE IF NOT EXISTS slack_user_links (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS slack_user_links_user_idx
  ON slack_user_links (user_id);
