ALTER TABLE auth_enrollments ADD COLUMN page_id TEXT;

CREATE UNIQUE INDEX auth_enrollments_page_id_idx
  ON auth_enrollments (page_id) WHERE page_id IS NOT NULL;
