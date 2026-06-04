-- schema.sql — Archive.FLO D1 Database
-- Run: wrangler d1 execute archive-flo-db --file=schema.sql

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT    NOT NULL UNIQUE,       -- Discord snowflake
  guild_id      TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  channel_name  TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  username      TEXT    NOT NULL,              -- Discord username
  display_name  TEXT,                          -- Server nickname or global name
  content       TEXT    DEFAULT '',
  attachments   TEXT    DEFAULT '[]',          -- JSON array of attachment objects
  reactions     TEXT    DEFAULT '[]',          -- JSON array of reaction objects
  created_at    TEXT    NOT NULL,              -- Original Discord message timestamp
  archived_at   TEXT    NOT NULL              -- When WE archived it
);

-- Cursor: tracks how far we've scraped each channel
-- so /log-channel never double-logs
CREATE TABLE IF NOT EXISTS channel_cursors (
  channel_id       TEXT PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  channel_name     TEXT NOT NULL,
  last_message_id  TEXT NOT NULL,             -- Newest Discord message ID we've seen
  last_scraped     TEXT NOT NULL              -- datetime
);

-- Tracks which users have been fully scraped
CREATE TABLE IF NOT EXISTS user_scrapes (
  user_id        TEXT PRIMARY KEY,
  guild_id       TEXT NOT NULL,
  username       TEXT NOT NULL,
  last_scraped   TEXT NOT NULL,
  total_messages INTEGER DEFAULT 0
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages (channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_user      ON messages (user_id);
CREATE INDEX IF NOT EXISTS idx_messages_guild     ON messages (guild_id);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_archived  ON messages (archived_at);
