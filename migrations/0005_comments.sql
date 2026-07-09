CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL
    CHECK (path <> '' AND path NOT LIKE '/%' AND path NOT LIKE '%..%'),
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  anchor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(anchor_json) AND json_type(anchor_json) = 'object'),
  selected_text TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved')),
  client_mutation_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, client_mutation_id)
);

CREATE INDEX idx_comment_threads_project_path_time
  ON comment_threads (project_id, path, created_at DESC);

CREATE INDEX idx_comment_threads_project_status_time
  ON comment_threads (project_id, status, created_at DESC);

CREATE TABLE comment_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_comment_replies_thread_time
  ON comment_replies (thread_id, created_at ASC);

CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE,
  reply_id TEXT REFERENCES comment_replies(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('comment_created','comment_replied')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notification_events_project_time
  ON notification_events (project_id, created_at DESC);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'app'
    CHECK (channel IN ('app','email','webhook')),
  status TEXT NOT NULL DEFAULT 'delivered'
    CHECK (status IN ('pending','delivered','failed')),
  read_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, recipient_user_id, channel)
);

CREATE INDEX idx_notification_deliveries_recipient_read_time
  ON notification_deliveries (recipient_user_id, read_at, created_at DESC);
