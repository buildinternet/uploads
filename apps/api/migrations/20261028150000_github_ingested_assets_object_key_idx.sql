CREATE INDEX github_ingested_assets_object_key_idx
  ON github_ingested_assets (object_key, workspace);
