import type { Env } from "../env";
import { withServiceAccount } from "../auth/service-account";
import { downloadDriveFile } from "./drive";
import { createTrackedFolder, generateDriveIds } from "./drive-objects";
import { randomId } from "../lib/id";

export type ProjectStorage = { drive_folder_id: string | null; storage_service_account: string | null; active_revision_id: string | null; storage_folder_parent_id: string | null; storage_folder_object_id: string | null };

export async function getProjectStorage(env: Env, projectId: string): Promise<ProjectStorage | null> {
  return env.DB.prepare("SELECT drive_folder_id, storage_service_account, active_revision_id, storage_folder_parent_id, storage_folder_object_id FROM projects WHERE id = ?")
    .bind(projectId).first<ProjectStorage>();
}

export function assertStorageAccount(env: Env, account: string): void {
  if (account !== env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error("service_account_mismatch");
}

export async function verifyServiceAccountLocation(env: Env, token: string, folderId: string, fileId?: string, allowTrashed = false): Promise<void> {
  const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/${encodeURIComponent(fileId ?? folderId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,mimeType,driveId,parents,trashed,capabilities(canEdit,canAddChildren,canDownload,canTrash)");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Drive location lookup failed with ${response.status}`);
  const metadata = await response.json<{ id?: string; mimeType?: string; driveId?: string; parents?: string[]; trashed?: boolean;
    capabilities?: { canEdit?: boolean; canAddChildren?: boolean; canDownload?: boolean; canTrash?: boolean } }>();
  if (metadata.id !== (fileId ?? folderId) || metadata.driveId !== env.TEAM_DRIVE_ID || (fileId && !metadata.parents?.includes(folderId))) {
    throw new Error("service_account_location_denied");
  }
  if (metadata.trashed && allowTrashed) return;
  if (metadata.trashed ||
      !metadata.capabilities?.canEdit || !metadata.capabilities.canTrash ||
      (fileId ? !metadata.parents?.includes(folderId) || !metadata.capabilities.canDownload :
        metadata.mimeType !== "application/vnd.google-apps.folder" || !metadata.capabilities.canAddChildren)) {
    throw new Error("service_account_location_denied");
  }
}

type Preparation = ProjectStorage & { alias: string; storage_transition_id: string; storage_transition_until: number;
  storage_preparation_folder_id: string | null; storage_preparation_source_folder_id: string | null;
  storage_preparation_account: string; storage_preparation_after_id: string | null };
const ownerCheck = "EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = projects.id AND pm.user_id = ? AND pm.role = 'owner' AND u.disabled_at IS NULL)";
const preparationColumns = "storage_transition_id = NULL, storage_transition_until = NULL, storage_preparation_folder_id = NULL, storage_preparation_source_folder_id = NULL, storage_preparation_account = NULL, storage_preparation_after_id = NULL";

export async function enableServiceAccountStorage(env: Env, projectId: string, ownerId: string): Promise<ProjectStorage | null> {
  const storage = await getProjectStorage(env, projectId);
  if (!storage) throw new Error("project_storage_changed");
  if (storage.storage_service_account) {
    assertStorageAccount(env, storage.storage_service_account);
    if (!storage.drive_folder_id) throw new Error("project_drive_folder_required");
    await withServiceAccount(env, token => verifyServiceAccountLocation(env, token, storage.drive_folder_id!));
    return storage;
  }
  const now = Date.now();
  await env.DB.prepare(`UPDATE projects SET storage_transition_id = ?, storage_transition_until = ?,
    storage_preparation_folder_id = drive_folder_id, storage_preparation_source_folder_id = drive_folder_id,
    storage_preparation_account = ?, storage_preparation_after_id = NULL
    WHERE id = ? AND storage_service_account IS NULL AND (storage_transition_id IS NULL OR storage_transition_until <= ?)
    AND NOT EXISTS (SELECT 1 FROM legacy_storage_operations l WHERE l.project_id = projects.id AND l.expires_at > ?) AND ${ownerCheck}`)
    .bind(randomId("switch"), now + 10 * 60000, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, projectId, now, now, ownerId).run();
  const preparation = await env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND storage_transition_id IS NOT NULL
    AND storage_transition_until > ? AND ${ownerCheck}`).bind(projectId, Date.now(), ownerId).first<Preparation>();
  if (!preparation) throw new Error("project_storage_changed");
  const current = `id = ? AND storage_transition_id = ? AND storage_transition_until > ? AND storage_service_account IS NULL
    AND drive_folder_id IS storage_preparation_source_folder_id AND storage_preparation_account = ? AND ${ownerCheck}`;
  const bindings = () => [projectId, preparation.storage_transition_id, Date.now(), env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, ownerId];
  try {
    if (preparation.storage_preparation_account !== env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
        preparation.storage_preparation_source_folder_id !== preparation.drive_folder_id) throw new Error("project_storage_changed");
    let folder = preparation.storage_preparation_folder_id;
    let parent: string | null = null;
    let operationId: string | null = null;
    if (!preparation.drive_folder_id) {
      const root = env.GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID;
      if (!root) throw new Error("service_account_root_not_configured");
      if (!folder) {
        const [id] = await withServiceAccount(env, token => generateDriveIds(env, token, 1));
        const result = await env.DB.batch([
          env.DB.prepare(`UPDATE projects SET storage_preparation_folder_id = ? WHERE ${current} AND storage_preparation_folder_id IS NULL`)
            .bind(id, ...bindings()),
          env.DB.prepare(`INSERT INTO drive_cleanup_folders (drive_folder_id, service_account, created_at, parent_id, operation_id)
            SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE ${current} AND storage_preparation_folder_id = ?)`)
            .bind(id, preparation.storage_preparation_account, Date.now(), root, preparation.storage_transition_id, ...bindings(), id)
        ]);
        if (!result[0].meta.changes) throw new Error("project_storage_changed");
        folder = id;
      }
      const tracked = await env.DB.prepare("SELECT parent_id, operation_id FROM drive_cleanup_folders WHERE drive_folder_id = ? AND service_account = ?")
        .bind(folder, preparation.storage_preparation_account).first<{ parent_id: string; operation_id: string }>();
      if (tracked?.parent_id !== root || tracked.operation_id !== preparation.storage_transition_id) throw new Error("project_storage_changed");
      parent = root;
      operationId = tracked.operation_id;
      await withServiceAccount(env, async token => {
        await verifyServiceAccountLocation(env, token, root);
        if (!(await env.DB.prepare(`SELECT 1 FROM projects WHERE ${current}`).bind(...bindings()).first())) throw new Error("project_storage_changed");
        await createTrackedFolder(env, token, { id: folder!, parentId: root, operationId: operationId!, name: preparation.alias });
      });
    }
    if (!folder) throw new Error("project_drive_folder_required");
    const files = await env.DB.prepare(`SELECT id, drive_file_id FROM project_files WHERE project_id = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT 2`)
      .bind(projectId, preparation.storage_preparation_after_id, preparation.storage_preparation_after_id).all<{ id: string; drive_file_id: string | null }>();
    await withServiceAccount(env, async token => {
      await verifyServiceAccountLocation(env, token, folder!);
      if (files.results[0]?.drive_file_id) await verifyServiceAccountLocation(env, token, folder!, files.results[0].drive_file_id);
    });
    if (files.results.length > 1) {
      const progress = await env.DB.prepare(`UPDATE projects SET storage_preparation_after_id = ? WHERE ${current}
        AND storage_preparation_folder_id = ? AND storage_preparation_after_id IS ?`)
        .bind(files.results[0].id, ...bindings(), folder, preparation.storage_preparation_after_id).run();
      if (!progress.meta.changes) throw new Error("project_storage_changed");
      return null;
    }
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE projects SET storage_service_account = ?, drive_folder_id = ?, storage_folder_parent_id = ?, storage_folder_object_id = ?, ${preparationColumns}
        WHERE ${current} AND storage_preparation_folder_id = ? AND storage_preparation_after_id IS ?`)
        .bind(preparation.storage_preparation_account, folder, parent, operationId, ...bindings(), folder, preparation.storage_preparation_after_id),
      env.DB.prepare(`DELETE FROM drive_cleanup_folders WHERE drive_folder_id = ? AND operation_id = ?
        AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND drive_folder_id = ? AND storage_folder_object_id = ?)`)
        .bind(folder, operationId, projectId, folder, operationId)
    ]);
    if (!results[0].meta.changes) throw new Error("project_storage_changed");
    return getProjectStorage(env, projectId);
  } catch (error) {
    // 通信失敗なら確認位置を保つ。権限や保存先の不一致では同じ準備を再利用しない。
    if (error instanceof Error && ["project_storage_changed", "service_account_location_denied", "drive_object_mismatch"].includes(error.message)) {
      await env.DB.prepare(`UPDATE projects SET ${preparationColumns} WHERE id = ? AND storage_transition_id = ?`)
        .bind(projectId, preparation.storage_transition_id).run();
    }
    throw error;
  }
}

export async function downloadWithServiceAccount(env: Env, account: string, folderId: string, fileId: string) {
  assertStorageAccount(env, account);
  return withServiceAccount(env, async (token) => {
    await verifyServiceAccountLocation(env, token, folderId, fileId);
    const file = await downloadDriveFile(env, token, fileId);
    if (file.status === 401) throw new Error("Drive download failed with 401");
    return file;
  });
}
