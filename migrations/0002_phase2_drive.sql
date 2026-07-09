ALTER TABLE projects ADD COLUMN drive_folder_id TEXT;

ALTER TABLE project_files ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE project_files ADD COLUMN drive_modified_time TEXT;
ALTER TABLE project_files ADD COLUMN cache_etag TEXT;
