CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at INTEGER,
  drive_folder_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','invite','domain','group','link','public')),
  allowed_domains TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(allowed_domains) AND json_type(allowed_domains) = 'array'),
  allowed_groups TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(allowed_groups) AND json_type(allowed_groups) = 'array'),
  entry_path TEXT NOT NULL DEFAULT 'index.html'
    CHECK (entry_path <> '' AND entry_path NOT LIKE '/%' AND entry_path NOT LIKE '%..%'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(alias) BETWEEN 3 AND 64),
  CHECK (alias NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (substr(alias, 1, 1) NOT IN ('-', '_'))
);

CREATE TABLE project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('owner','editor','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, user_id)
);

CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL
    CHECK (path <> '' AND path NOT LIKE '/%' AND path NOT LIKE '%..%'),
  drive_file_id TEXT,
  drive_owner_user_id TEXT REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, path)
);

CREATE TABLE project_access (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, email)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["read","write","deploy"]'
    CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('owner','editor','viewer')),
  accepted_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, email)
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  redirect_to TEXT NOT NULL
    CHECK (redirect_to <> '' AND redirect_to LIKE '/%' AND redirect_to NOT LIKE '//%'),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
