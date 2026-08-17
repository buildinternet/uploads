-- Last-used stamp for issued tokens on /account/developers. Nullable: unused
-- tokens and rows minted before this migration stay NULL. Touched on a
-- successful auth, at most once an hour (see touchTokenLastUsed).
ALTER TABLE auth_tokens ADD COLUMN last_used_at TEXT;
