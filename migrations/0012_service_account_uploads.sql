ALTER TABLE projects ADD COLUMN storage_service_account TEXT;
ALTER TABLE projects ADD COLUMN active_revision_id TEXT;
ALTER TABLE projects ADD COLUMN storage_transition_id TEXT;
ALTER TABLE projects ADD COLUMN storage_transition_until INTEGER;

CREATE TABLE legacy_storage_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE upload_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX upload_keys_project ON upload_keys(project_id);

CREATE TABLE project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_revision_id TEXT,
  actor_id TEXT NOT NULL,
  upload_key_id TEXT,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(project_id, actor_id, request_id)
);

CREATE TABLE upload_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  drive_folder_id TEXT NOT NULL,
  drive_file_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  service_account TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX upload_objects_project ON upload_objects(project_id);

CREATE TABLE drive_cleanup_folders (
  drive_folder_id TEXT PRIMARY KEY,
  service_account TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE security_events ADD COLUMN upload_key_id TEXT;
ALTER TABLE security_events ADD COLUMN service_account TEXT;
ALTER TABLE security_events ADD COLUMN rejection_reason TEXT;

CREATE TABLE deploy_events_sa (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  deploy_type TEXT NOT NULL DEFAULT 'file' CHECK (deploy_type IN ('file', 'zip')),
  path TEXT,
  files_count INTEGER NOT NULL DEFAULT 1 CHECK (files_count >= 0),
  total_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_size_bytes >= 0),
  content_hash TEXT,
  deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
  upload_key_id TEXT,
  service_account TEXT,
  revision_id TEXT
);
INSERT INTO deploy_events_sa (id, project_id, deployer_user_id, deploy_type, path, files_count, total_size_bytes, content_hash, deployed_at)
SELECT id, project_id, deployer_user_id, deploy_type, path, files_count, total_size_bytes, content_hash, deployed_at FROM deploy_events;
DROP TABLE deploy_events;
ALTER TABLE deploy_events_sa RENAME TO deploy_events;
CREATE INDEX idx_deploy_events_project_time ON deploy_events(project_id, deployed_at DESC);
