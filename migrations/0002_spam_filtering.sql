-- Spam filtering: per-message verdict plus user-managed sender rules.
ALTER TABLE messages ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN spam_score REAL NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN spam_reasons TEXT NOT NULL DEFAULT '[]'; -- JSON array of strings

-- Folders are now (direction, is_spam): inbox = in/0, spam = in/1, sent = out/0.
DROP INDEX idx_messages_folder_time;
CREATE INDEX idx_messages_folder_time ON messages (direction, is_spam, received_at DESC, id DESC);

-- pattern is a lowercase address ("bob@example.com") or a whole domain ("@example.com").
-- An exact address rule wins over a domain rule.
CREATE TABLE sender_rules (
  pattern    TEXT PRIMARY KEY,
  action     TEXT NOT NULL CHECK (action IN ('allow', 'spam', 'block')),
  created_at TEXT NOT NULL
);
