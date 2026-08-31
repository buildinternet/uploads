-- Issue #911: refresh tokens are only issued when the grant carries
-- offline_access, which no client was registered for. New registrations get
-- it via clientRegistrationDefaultScopes (apps/auth/src/auth.ts); this
-- backfills every existing oauth_client row so already-registered clients
-- (OpenCode, Cursor, MCP Inspector, ...) can hold refresh tokens without
-- re-registering. `scopes` is a JSON TEXT array; json_insert('$[#]')
-- appends. Rows already carrying the scope (none today, but the migration
-- must be re-runnable against previews) are skipped.
UPDATE oauth_client
SET scopes = json_insert(scopes, '$[#]', 'offline_access')
WHERE scopes IS NOT NULL
  AND json_valid(scopes)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(oauth_client.scopes)
    WHERE json_each.value = 'offline_access'
  );
