CREATE TABLE comment_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('status_changed','comment_updated')),
  previous_status TEXT
    CHECK (previous_status IS NULL OR previous_status IN ('open','resolved')),
  next_status TEXT
    CHECK (next_status IS NULL OR next_status IN ('open','resolved')),
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_comment_events_thread_time
  ON comment_events (thread_id, created_at ASC, id ASC);
