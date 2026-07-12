-- First-admin bootstrap (plan D9). Primary path: run this after the first
-- human signs in via GitHub or magic link. D1 does not support `?`
-- positional params in a plain .sql file run via `wrangler d1 execute
-- --file`, so this is documented as a one-liner substitution rather than run
-- directly as a file.
--
-- Usage (substitute the email, then run from apps/auth):
--
--   wrangler d1 execute uploads-auth --remote --command \
--     "UPDATE user SET role = 'admin' WHERE email = 'someone@example.com';"
--
-- Fallback if D1 console access is inconvenient (e.g. from CI/ops tooling):
-- POST /admin/users/promote on apps/api, ADMIN_TOKEN-gated, body {"email": "..."}.
-- See apps/api/src/routes/admin.ts.

UPDATE user SET role = 'admin' WHERE email = '<REPLACE_WITH_EMAIL>';
