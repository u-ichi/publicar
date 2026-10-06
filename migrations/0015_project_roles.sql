-- プロジェクトでの権限は Google の共有ドライブと同じ規則にする。
-- 組織の利用者（kind = 'member'、無効化されていない）は全プロジェクトの所有者として扱う。
-- 社外の利用者（guest）は project_access の招待で閲覧とコメントだけを許可し、このビューには含めない。
-- 権限の判定はこのビューだけを参照する。project_members は作成者の記録と通知の宛先に残す。
CREATE VIEW project_roles AS
SELECT p.id AS project_id, u.id AS user_id, 'owner' AS role
FROM projects p
CROSS JOIN users u
WHERE u.kind = 'member' AND u.disabled_at IS NULL
