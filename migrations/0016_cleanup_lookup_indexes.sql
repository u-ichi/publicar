-- 後片付けの対象選びで、未参照かどうかを索引で確かめる（全件走査で D1 の読み取り行数が件数の積で増えていた）
CREATE INDEX project_files_drive_file ON project_files(drive_file_id);
CREATE INDEX upload_objects_drive_folder ON upload_objects(drive_folder_id);
