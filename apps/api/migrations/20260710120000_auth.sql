CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX auth_tokens_workspace_idx ON auth_tokens (workspace, created_at);
CREATE INDEX auth_tokens_active_hash_idx ON auth_tokens (token_hash, revoked_at, expires_at);

CREATE TABLE auth_enrollments (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX auth_enrollments_code_idx ON auth_enrollments (code_hash, used_at, expires_at);
