import type { Env } from "../env";
import { serviceAccountConfigured, withServiceAccount } from "../auth/service-account";
import { trashDriveFile } from "./drive";
import { verifyServiceAccountLocation } from "./service-account-drive";

type UploadObject = { id: string; project_id: string; drive_folder_id: string; drive_file_id: string | null; r2_key: string; service_account: string };
// 公開処理の最大5分より長く待ち、転送中のファイルを整理対象にしない。
export const CLEANUP_DELAY_MS = 60 * 60 * 1000;

async function trash(env: Env, token: string, folder: string, file?: string) {
  try {
    await verifyServiceAccountLocation(env, token, folder, file, true);
    await trashDriveFile(env, token, file ?? folder);
  } catch (error) {
    if (!(error instanceof Error && /\b404\b/.test(error.message))) throw error;
  }
}

async function findUnrecordedFiles(env: Env, token: string, object: UploadObject): Promise<string[]> {
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files`);
  url.searchParams.set("q", `'${quote(object.drive_folder_id)}' in parents and trashed = false and appProperties has { key='publicar_upload_object' and value='${quote(object.id)}' }`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("fields", "files(id),nextPageToken");
  url.searchParams.set("pageSize", "100");
  const files: string[] = [];
  do {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Drive cleanup lookup failed with ${response.status}`);
    const result = await response.json<{ files: Array<{ id: string }>; nextPageToken?: string }>();
    files.push(...result.files.map(file => file.id));
    if (!result.nextPageToken) break;
    url.searchParams.set("pageToken", result.nextPageToken);
  } while (true);
  return files;
}

export async function cleanupUploads(env: Env): Promise<void> {
  if (!serviceAccountConfigured(env)) return;
  const before = Date.now() - CLEANUP_DELAY_MS;
  const candidates = await env.DB.prepare(`SELECT * FROM upload_objects o WHERE created_at < ? AND service_account = ?
    AND NOT EXISTS (SELECT 1 FROM project_files f WHERE f.r2_key = o.r2_key OR f.drive_file_id = o.drive_file_id)
    ORDER BY created_at LIMIT 100`).bind(before, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!).all<UploadObject>();
  for (const object of candidates.results) {
    try {
      await withServiceAccount(env, async (token) => {
        const files = object.drive_file_id ? [object.drive_file_id] : await findUnrecordedFiles(env, token, object);
        for (const file of files) {
          if (await env.DB.prepare("SELECT 1 FROM project_files WHERE drive_file_id = ?").bind(file).first()) throw new Error("file_in_use");
          await trash(env, token, object.drive_folder_id, file);
        }
      });
      await env.CACHE_BUCKET.delete(object.r2_key);
      await env.DB.prepare("DELETE FROM upload_objects WHERE id = ?").bind(object.id).run();
    } catch {
      // 保存済みの整理対象を残し、次の定期実行で再試行する。秘密情報を含む外部応答は記録しない。
      console.warn("upload_cleanup_pending", object.id);
    }
  }
  const folders = await env.DB.prepare(`SELECT drive_folder_id, service_account FROM drive_cleanup_folders c WHERE created_at < ? AND service_account = ?
    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.drive_folder_id = c.drive_folder_id)
    AND NOT EXISTS (SELECT 1 FROM upload_objects o WHERE o.drive_folder_id = c.drive_folder_id) LIMIT 20`)
    .bind(before, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!).all<{ drive_folder_id: string; service_account: string }>();
  for (const folder of folders.results) {
    try {
      await withServiceAccount(env, token => trash(env, token, folder.drive_folder_id));
      await env.DB.prepare("DELETE FROM drive_cleanup_folders WHERE drive_folder_id = ?").bind(folder.drive_folder_id).run();
    } catch { console.warn("folder_cleanup_pending", folder.drive_folder_id); }
  }
}
