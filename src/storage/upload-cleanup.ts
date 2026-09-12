import type { Env } from "../env";
import { serviceAccountConfigured, withServiceAccount } from "../auth/service-account";
import { trashDriveFile } from "./drive";
import { verifyServiceAccountLocation } from "./service-account-drive";
import { verifyDriveObject } from "./drive-objects";

type UploadObject = { id: string; project_id: string; drive_folder_id: string; drive_file_id: string | null; r2_key: string;
  service_account: string; operation_id: string | null; search_page_token: string | null; search_found_in_use: number };
export const CLEANUP_DELAY_MS = 60 * 60 * 1000;
const CLEANUP_LIMIT = 5;
const RETRY_DELAY_MS = 5 * 60 * 1000;

async function trash(env: Env, token: string, folder: string, file?: string, operationId?: string | null, parentId?: string | null) {
  try {
    if (operationId) {
      if (!file && !parentId) throw new Error("drive_object_mismatch");
      await verifyDriveObject(env, token, { id: file ?? folder, parentId: file ? folder : parentId!, operationId, folder: !file, allowTrashed: true });
    } else {
      await verifyServiceAccountLocation(env, token, folder, file, true);
    }
    // 外部照合の間に参照が変わっていないことも、削除直前に確認する。
    const used = file ? await env.DB.prepare("SELECT 1 FROM project_files WHERE drive_file_id = ?").bind(file).first() :
      await env.DB.prepare(`SELECT 1 FROM projects WHERE drive_folder_id = ? OR (storage_preparation_folder_id = ? AND storage_transition_until > ?)
        UNION ALL SELECT 1 FROM upload_objects WHERE drive_folder_id = ? LIMIT 1`).bind(folder, folder, Date.now(), folder).first();
    if (used) throw new Error("file_in_use");
    await trashDriveFile(env, token, file ?? folder);
  } catch (error) {
    if (!(error instanceof Error && /^Drive .* failed with 404\b/.test(error.message))) throw error;
  }
}

async function findUnrecordedFile(env: Env, token: string, object: UploadObject) {
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files`);
  url.searchParams.set("q", `'${quote(object.drive_folder_id)}' in parents and trashed = false and appProperties has { key='publicar_upload_object' and value='${quote(object.id)}' }`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("fields", "files(id),nextPageToken");
  url.searchParams.set("pageSize", "1");
  if (object.search_page_token) url.searchParams.set("pageToken", object.search_page_token);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Drive cleanup lookup failed with ${response.status}`);
  return response.json<{ files: Array<{ id: string }>; nextPageToken?: string }>();
}

export async function cleanupUploads(env: Env): Promise<void> {
  if (!serviceAccountConfigured(env)) return;
  const now = Date.now();
  const before = now - CLEANUP_DELAY_MS;
  // 両方の待ち行列を同じ順番で選び、失敗ファイルがフォルダ削除を妨げないようにする。
  const candidates = await env.DB.prepare(`SELECT 'file' AS kind, id, retry_at, created_at FROM upload_objects o
    WHERE created_at < ? AND retry_at <= ? AND service_account = ?
      AND NOT EXISTS (SELECT 1 FROM project_files f WHERE f.r2_key = o.r2_key OR f.drive_file_id = o.drive_file_id)
    UNION ALL
    SELECT 'folder', drive_folder_id, retry_at, created_at FROM drive_cleanup_folders c
    WHERE created_at < ? AND retry_at <= ? AND service_account = ?
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.drive_folder_id = c.drive_folder_id OR
        (p.storage_preparation_folder_id = c.drive_folder_id AND p.storage_transition_until > ?))
      AND NOT EXISTS (SELECT 1 FROM upload_objects o WHERE o.drive_folder_id = c.drive_folder_id)
    ORDER BY retry_at, created_at, kind, id LIMIT ?`)
    .bind(before, now, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, before, now, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, now, CLEANUP_LIMIT)
    .all<{ kind: "file" | "folder"; id: string }>();
  for (const candidate of candidates.results) {
    if (candidate.kind === "folder") {
      const folder = await env.DB.prepare("SELECT * FROM drive_cleanup_folders WHERE drive_folder_id = ?")
        .bind(candidate.id).first<{ drive_folder_id: string; operation_id: string | null; parent_id: string | null }>();
      if (!folder) continue;
      try {
        await withServiceAccount(env, token => trash(env, token, folder.drive_folder_id, undefined, folder.operation_id, folder.parent_id));
        await env.DB.prepare("DELETE FROM drive_cleanup_folders WHERE drive_folder_id = ?").bind(folder.drive_folder_id).run();
      } catch {
        await env.DB.prepare("UPDATE drive_cleanup_folders SET retry_at = ? WHERE drive_folder_id = ?").bind(Date.now() + RETRY_DELAY_MS, folder.drive_folder_id).run();
        console.warn("folder_cleanup_pending", folder.drive_folder_id);
      }
      continue;
    }
    const object = await env.DB.prepare("SELECT * FROM upload_objects WHERE id = ?").bind(candidate.id).first<UploadObject>();
    if (!object) continue;
    try {
      const finished = await withServiceAccount(env, async token => {
        if (object.drive_file_id) {
          await trash(env, token, object.drive_folder_id, object.drive_file_id, object.operation_id);
          return true;
        }
        const page = await findUnrecordedFile(env, token, object);
        if (page.files.length > 1) throw new Error("Drive cleanup lookup failed: oversized page");
        const file = page.files[0];
        const used = file && await env.DB.prepare("SELECT 1 FROM project_files WHERE drive_file_id = ?").bind(file.id).first();
        if (file && !used) await trash(env, token, object.drive_folder_id, file.id, object.id);
        const foundInUse = Boolean(used || object.search_found_in_use);
        if (page.nextPageToken || foundInUse) {
          await env.DB.prepare("UPDATE upload_objects SET search_page_token = ?, search_found_in_use = ?, retry_at = ? WHERE id = ?")
            .bind(page.nextPageToken ?? null, page.nextPageToken && foundInUse ? 1 : 0, Date.now() + 60000, object.id).run();
          return false;
        }
        return true;
      });
      if (!finished) continue;
      if (await env.DB.prepare("SELECT 1 FROM project_files WHERE r2_key = ?").bind(object.r2_key).first()) throw new Error("file_in_use");
      await env.CACHE_BUCKET.delete(object.r2_key);
      await env.DB.prepare("DELETE FROM upload_objects WHERE id = ?").bind(object.id).run();
    } catch {
      await env.DB.prepare("UPDATE upload_objects SET retry_at = ? WHERE id = ?").bind(Date.now() + RETRY_DELAY_MS, object.id).run();
      console.warn("upload_cleanup_pending", object.id);
    }
  }
}
