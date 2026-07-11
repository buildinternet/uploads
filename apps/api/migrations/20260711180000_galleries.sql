CREATE TABLE galleries (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility = 'public'),
  cover_item_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX galleries_workspace_created_idx
  ON galleries (workspace, created_at, id);

CREATE TABLE gallery_items (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  position INTEGER NOT NULL CHECK (position > 0),
  caption TEXT,
  alt_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (gallery_id, object_key),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE
);

CREATE INDEX gallery_items_order_idx
  ON gallery_items (gallery_id, position, id);

CREATE TABLE gallery_external_references (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 64),
  normalized_key TEXT NOT NULL CHECK (length(normalized_key) BETWEEN 1 AND 512),
  locator_json TEXT NOT NULL,
  canonical_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (gallery_id, normalized_key),
  FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE
);

CREATE INDEX gallery_external_references_lookup_idx
  ON gallery_external_references (normalized_key, gallery_id);
