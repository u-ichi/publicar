CREATE TABLE deploy_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deploy_type TEXT NOT NULL DEFAULT 'file'
    CHECK (deploy_type IN ('file', 'zip')),
  path TEXT,
  files_count INTEGER NOT NULL DEFAULT 1 CHECK (files_count >= 0),
  total_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_size_bytes >= 0),
  content_hash TEXT,
  deployed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deploy_events_project_time
  ON deploy_events (project_id, deployed_at DESC);
