-- Phase 2: `admin` plugin (see src/auth.ts, plan D3/D9).
--
-- `user.role`/`banned`/`ban_reason`/`ban_expires` were already added in the
-- Phase 1 migration (migrations/20260712200000_better_auth_core.sql) —
-- verified against that file's CREATE TABLE for `user` before writing this
-- one, so this migration only needs the column the admin plugin's
-- impersonation feature writes to `session`, which Phase 1 didn't anticipate.
-- Paired with src/schema.ts's `session.impersonatedBy`.

ALTER TABLE session ADD COLUMN impersonated_by TEXT;
