-- Messages, both received ('in') and sent ('out').
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  received_at    TEXT NOT NULL,              -- ISO 8601; when the Worker handled it
  envelope_from  TEXT,
  envelope_to    TEXT,
  from_addr      TEXT NOT NULL,              -- display form, e.g. "Alice <alice@example.com>"
  from_email     TEXT,                       -- bare address, used for replies
  reply_to       TEXT,                       -- bare Reply-To address, if any
  to_addrs       TEXT NOT NULL DEFAULT '[]', -- JSON array of display addresses
  cc_addrs       TEXT NOT NULL DEFAULT '[]',
  subject        TEXT NOT NULL DEFAULT '',
  message_id     TEXT,
  in_reply_to    TEXT,
  references_hdr TEXT,
  sent_date      TEXT,                       -- Date header
  text           TEXT,
  html           TEXT,
  snippet        TEXT NOT NULL DEFAULT '',
  raw_key        TEXT,                       -- R2 key of the original .eml
  raw_size       INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0, -- 1 if a body was cut to fit D1 limits
  is_read        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_folder_time ON messages (direction, received_at DESC, id DESC);
CREATE INDEX idx_messages_received ON messages (received_at);

-- Attachment metadata; the bytes live in R2.
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  filename    TEXT,
  mime_type   TEXT NOT NULL,
  disposition TEXT,
  content_id  TEXT,                          -- set for inline images referenced as cid: in HTML
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL
);

CREATE INDEX idx_attachments_message ON attachments (message_id);

-- Full-text search over subject, sender and plain-text body.
-- External-content table: the text is stored once, in `messages`.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  subject, from_addr, text,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, from_addr, text)
  VALUES (new.rowid, new.subject, new.from_addr, new.text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_addr, text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.text);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, from_addr, text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_addr, text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.text);
  INSERT INTO messages_fts (rowid, subject, from_addr, text)
  VALUES (new.rowid, new.subject, new.from_addr, new.text);
END;
