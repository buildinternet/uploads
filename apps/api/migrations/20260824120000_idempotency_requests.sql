CREATE TABLE idempotency_requests (
  workspace TEXT NOT NULL,
  principal TEXT NOT NULL,
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  owner_nonce TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace, principal, operation, key_hash)
);

CREATE INDEX idempotency_requests_expires_idx
  ON idempotency_requests (expires_at);
