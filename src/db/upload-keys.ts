import type { Env } from "../env";
import { sha256Base64Url } from "../lib/crypto";
import { randomBase64Url } from "../lib/encoding";
import { randomId } from "../lib/id";

export type UploadKey = { id: string; project_id: string; name: string; created_by: string | null; expires_at: string; revoked_at: string | null; created_at: string };
export const UPLOAD_KEY_PREFIX = "upl_";
export const uploadKeyColumns = "id, project_id, name, created_by, expires_at, revoked_at, created_at";

export async function createUploadKey(env: Env, input: { projectId: string; name: string; createdBy: string; expiresAt: string }) {
  const rawKey = UPLOAD_KEY_PREFIX + randomBase64Url(32);
  const key = await env.DB.prepare(`INSERT INTO upload_keys (id, project_id, name, key_hash, created_by, expires_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? AND pm.user_id = ? AND pm.role = 'owner' AND u.disabled_at IS NULL)
    RETURNING ${uploadKeyColumns}`)
    .bind(randomId("uk"), input.projectId, input.name, await sha256Base64Url(rawKey), input.createdBy, input.expiresAt, input.projectId, input.createdBy).first<UploadKey>();
  if (!key) throw new Error("project_owner_required");
  return { key, raw_key: rawKey };
}

export async function findUploadKey(env: Env, rawKey: string): Promise<UploadKey | null> {
  return env.DB.prepare(`SELECT ${uploadKeyColumns} FROM upload_keys WHERE key_hash = ?`)
    .bind(await sha256Base64Url(rawKey)).first<UploadKey>();
}
