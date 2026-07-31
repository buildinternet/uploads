-- Issue #580: capture the GitHub login at OAuth-link time, keyed by the
-- numeric GitHub account id (not user id — see src/schema.ts's githubIdentity
-- comment for why). Populated by src/auth.ts's github mapProfileToUser hook
-- on every completed GitHub OAuth callback (link + re-authentication).
CREATE TABLE github_identity (
  account_id TEXT PRIMARY KEY NOT NULL,
  login TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
