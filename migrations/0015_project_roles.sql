-- プロジェクトでの権限は Google の共有ドライブのメンバーで決める。
-- drive_member_emails と drive_member_domains は、定期処理が共有ドライブの共有一覧から取り込んだ結果（Google グループは中の人まで展開する）。
-- 取り込みに一度も成功していない間は、組織の利用者（kind = 'member'、無効化されていない）全員を所有者として扱う。
-- 社外の利用者（guest）は project_access の招待で閲覧とコメントだけを許可し、このビューには含めない。
-- 権限の判定はこのビューだけを参照する。project_members は作成者の記録と通知の宛先に残す。
CREATE TABLE drive_member_emails (
  email TEXT PRIMARY KEY
);

CREATE TABLE drive_member_domains (
  domain TEXT PRIMARY KEY
);

CREATE TABLE drive_member_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  source TEXT,
  member_count INTEGER,
  domain_count INTEGER,
  group_count INTEGER
);

CREATE VIEW drive_member_users AS
SELECT u.id AS user_id
FROM users u
WHERE u.kind = 'member' AND u.disabled_at IS NULL AND (
  NOT EXISTS (SELECT 1 FROM drive_member_sync s WHERE s.id = 1 AND s.last_success_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM drive_member_emails e WHERE e.email = lower(u.email))
  OR EXISTS (SELECT 1 FROM drive_member_domains d WHERE d.domain = lower(substr(u.email, instr(u.email, '@') + 1)))
);

CREATE VIEW project_roles AS
SELECT p.id AS project_id, m.user_id AS user_id, 'owner' AS role
FROM projects p
CROSS JOIN drive_member_users m;
