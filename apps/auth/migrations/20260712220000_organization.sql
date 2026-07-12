-- Phase 3: `organization` plugin (see src/auth.ts, plan D3/D4).
--
-- No `team` support (explicitly out of scope, D3) and no personal-org
-- auto-provisioning (D4 — orgs are admin-provisioned only via
-- /internal/orgs or the KV-workspace backfill script). Table shapes
-- reconciled against `npx @better-auth/cli generate` for the organization
-- plugin and ~/Code/releases/workers/api/src/db/schema-auth.ts (trimmed:
-- that repo's org auto-provisioning hook is deliberately not copied).
-- Paired with src/schema.ts — keep both in sync by hand (see the JSDoc there).

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  created_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE member (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_member_organization_id ON member (organization_id);
CREATE INDEX idx_member_user_id ON member (user_id);

CREATE TABLE invitation (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_invitation_organization_id ON invitation (organization_id);

-- session.active_organization_id: written by the organization plugin to
-- track which org a multi-org user is currently acting as. Verified against
-- `migrations/20260712200000_better_auth_core.sql` and
-- `migrations/20260712210000_admin_plugin.sql` — this is the only Phase 3
-- ALTER TABLE needed on `session`.
ALTER TABLE session ADD COLUMN active_organization_id TEXT;
