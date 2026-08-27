-- Issue #869 phase B: workspace-admin "join" invite links.
--
-- `auth_enrollments` rows have so far only ever redeemed into a CLI token
-- (`kind = 'token'`, the implicit behavior before this column existed).
-- Adds a `kind = 'member'` variant whose redemption instead adds the
-- redeemer as an org member (see apps/api/src/routes/auth.ts's
-- `POST /auth/enrollments/join` and apps/auth's `POST /internal/join`).
ALTER TABLE auth_enrollments ADD COLUMN kind TEXT NOT NULL DEFAULT 'token';
