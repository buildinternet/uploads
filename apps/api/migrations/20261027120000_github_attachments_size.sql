-- Size and stored content type for each attachment row (issue #955 phase 3),
-- so the managed comment can render from the index without listing R2: the
-- listing used to supply both, and the non-media file table shows the size.
-- Nullable: rows written before this migration have neither until the
-- backfill or a re-write fills them; the comment renders them as unknown.
ALTER TABLE github_attachments ADD COLUMN size INTEGER;
ALTER TABLE github_attachments ADD COLUMN content_type TEXT;
