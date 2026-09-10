-- users.kind: member (組織ドメイン) / guest (外部招待)
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'member'
  CHECK (kind IN ('member', 'guest'));

-- project_access を claim 可能にする (email → user_id)
ALTER TABLE project_access ADD COLUMN user_id TEXT REFERENCES users(id);

-- R-006: lower(email) 正規化の前に (project_id, lower(email)) 単位で survivor 以外を削除
-- survivor = created_at 最古、同時刻は id 昇順
DELETE FROM project_access
WHERE id IN (
  SELECT pa.id
  FROM project_access pa
  WHERE EXISTS (
    SELECT 1
    FROM project_access better
    WHERE better.project_id = pa.project_id
      AND lower(better.email) = lower(pa.email)
      AND (
        better.created_at < pa.created_at
        OR (better.created_at = pa.created_at AND better.id < pa.id)
      )
  )
);

UPDATE project_access SET email = lower(email);

CREATE UNIQUE INDEX idx_project_access_project_email_lower
  ON project_access (project_id, lower(email));

-- R-007: claim 済みは (project_id, user_id) で一意
CREATE UNIQUE INDEX idx_project_access_project_user
  ON project_access (project_id, user_id)
  WHERE user_id IS NOT NULL;
