-- APIキーは発行した本人として扱い、権限やプロジェクトでの絞り込みをやめる。
-- 絞り込んで発行済みのキーをそのまま残すと本人と同じ権限に広がるため、取り消す。
UPDATE api_keys
SET revoked_at = datetime('now')
WHERE revoked_at IS NULL
  AND (
    project_id IS NOT NULL
    OR scopes NOT LIKE '%"read"%'
    OR scopes NOT LIKE '%"write"%'
    OR scopes NOT LIKE '%"deploy"%'
  );
