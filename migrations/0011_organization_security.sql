ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;

CREATE TABLE automation_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  drive_user_id TEXT NOT NULL REFERENCES users(id),
  drive_folder_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE api_keys ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD COLUMN automation_grant_id TEXT REFERENCES automation_grants(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;

CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  auth_method TEXT NOT NULL,
  api_key_id TEXT,
  automation_grant_id TEXT,
  project_id TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  repository TEXT,
  commit_sha TEXT,
  ci_run_id TEXT,
  drive_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX security_events_created_at ON security_events(created_at);
CREATE INDEX security_events_project_id ON security_events(project_id, created_at);

DROP TABLE cli_auth_states;
CREATE TABLE cli_auth_states (
  state TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorizing', 'completed', 'consumed')),
  api_key_raw TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consent_user_id TEXT,
  consent_session_key TEXT,
  consent_token_hash TEXT,
  api_key_id TEXT
);
