ALTER TABLE drafts ADD COLUMN page_revision INTEGER;
CREATE TABLE media_items (
  token TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  archive_message_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('video','image')),
  mime_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  UNIQUE(source_chat_id, source_message_id)
);
CREATE INDEX media_draft_order ON media_items(draft_id, source_message_id);
INSERT INTO media_items
SELECT token,id,source_chat_id,source_message_id,file_id,file_size,archive_message_id,
       'video','video/mp4','mp4' FROM drafts;
CREATE TABLE albums (
  chat_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  PRIMARY KEY(chat_id,group_id)
);
CREATE TABLE incoming_albums (
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX incoming_album_group ON incoming_albums(chat_id,group_id);
