-- Issue #876: multi-use, non-expiring member-kind join links.
--
-- `max_uses` (NULL = unlimited) and `use_count` replace `used_at` as the
-- lifecycle stamp for `kind = 'member'` rows — see auth-db.ts's
-- `claimMemberEnrollment`/`releaseEnrollmentClaim`, now an atomic
-- conditional increment/decrement instead of the single-winner `used_at`
-- UPDATE. `kind = 'token'` rows are untouched: `used_at` keeps its exact
-- pre-#876 single-use meaning; `max_uses`/`use_count` stay unused (NULL/0)
-- for them.
--
-- `expires_at` also becomes nullable — a non-expiring member-kind link has
-- no expiry at all (NULL), not a far-future date. Token-kind minting paths
-- keep requiring an explicit TTL; this only widens the column for the rows
-- that need it. SQLite can't drop a NOT NULL constraint with a plain ALTER,
-- so the table is rebuilt (standard 4-step SQLite pattern).
PRAGMA foreign_keys=OFF;

CREATE TABLE auth_enrollments_new (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  token_expires_at TEXT NOT NULL,
  used_at TEXT,
  page_id TEXT,
  kind TEXT NOT NULL DEFAULT 'token',
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO auth_enrollments_new
  (id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at,
   used_at, page_id, kind, max_uses, use_count)
SELECT id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at,
       used_at, page_id, kind, NULL, 0
FROM auth_enrollments;

DROP TABLE auth_enrollments;
ALTER TABLE auth_enrollments_new RENAME TO auth_enrollments;

CREATE INDEX auth_enrollments_code_idx ON auth_enrollments (code_hash, used_at, expires_at);
CREATE UNIQUE INDEX auth_enrollments_page_id_idx
  ON auth_enrollments (page_id) WHERE page_id IS NOT NULL;

PRAGMA foreign_keys=ON;
