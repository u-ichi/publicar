CREATE TABLE access_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_access_logs_project_time
  ON access_logs (project_id, accessed_at DESC);

CREATE INDEX idx_access_logs_project_user_time
  ON access_logs (project_id, user_id, accessed_at DESC);
