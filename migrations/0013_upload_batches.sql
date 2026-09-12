ALTER TABLE projects ADD COLUMN storage_preparation_folder_id TEXT;
ALTER TABLE projects ADD COLUMN storage_preparation_source_folder_id TEXT;
ALTER TABLE projects ADD COLUMN storage_preparation_account TEXT;
ALTER TABLE projects ADD COLUMN storage_preparation_after_id TEXT;
ALTER TABLE projects ADD COLUMN storage_folder_parent_id TEXT;
ALTER TABLE projects ADD COLUMN storage_folder_object_id TEXT;

ALTER TABLE project_revisions ADD COLUMN manifest_json TEXT;
ALTER TABLE project_revisions ADD COLUMN expires_at INTEGER;
ALTER TABLE project_revisions ADD COLUMN drive_folder_id TEXT;
ALTER TABLE project_revisions ADD COLUMN service_account TEXT;
ALTER TABLE project_revisions ADD COLUMN entry_path TEXT;

ALTER TABLE upload_objects ADD COLUMN operation_id TEXT;
ALTER TABLE upload_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_objects ADD COLUMN search_page_token TEXT;
ALTER TABLE upload_objects ADD COLUMN search_found_in_use INTEGER NOT NULL DEFAULT 0;
CREATE INDEX upload_objects_cleanup ON upload_objects(service_account, retry_at, created_at);

CREATE TABLE upload_parts (
  revision_id TEXT NOT NULL REFERENCES project_revisions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  object_id TEXT NOT NULL,
  drive_modified_time TEXT,
  cache_etag TEXT NOT NULL,
  PRIMARY KEY (revision_id, path)
);

ALTER TABLE drive_cleanup_folders ADD COLUMN parent_id TEXT;
ALTER TABLE drive_cleanup_folders ADD COLUMN operation_id TEXT;
ALTER TABLE drive_cleanup_folders ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
