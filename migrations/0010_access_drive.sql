-- 招待と Drive フォルダ権限の連動用カラム
ALTER TABLE project_access ADD COLUMN drive_role TEXT
  CHECK (drive_role IS NULL OR drive_role IN ('reader', 'commenter', 'writer'));

ALTER TABLE project_access ADD COLUMN drive_permission_id TEXT;

ALTER TABLE project_access ADD COLUMN drive_error TEXT;
