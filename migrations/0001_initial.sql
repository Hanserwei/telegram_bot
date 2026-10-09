CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  archive_message_id INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'publishing', 'published', 'uncertain', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 0,
  page_url TEXT,
  page_path TEXT,
  page_title TEXT,
  published_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_chat_id, source_message_id)
);
CREATE INDEX drafts_owner_time ON drafts(owner_id, created_at DESC);
CREATE INDEX drafts_status_time ON drafts(status, updated_at);
CREATE TABLE message_links (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
