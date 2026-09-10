import type { Env } from "../env";
import { withServiceAccount } from "../auth/service-account";
import { downloadDriveFile, createDriveFolder } from "./drive";
import { randomId } from "../lib/id";

export type ProjectStorage = { drive_folder_id: string | null; storage_service_account: string | null; active_revision_id: string | null };

export async function getProjectStorage(env: Env, projectId: string): Promise<ProjectStorage | null> {
  return env.DB.prepare("SELECT drive_folder_id, storage_service_account, active_revision_id FROM projects WHERE id = ?")
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

export async function enableServiceAccountStorage(env: Env, projectId: string, ownerId: string): Promise<ProjectStorage> {
  const storage = await getProjectStorage(env, projectId);
  if (!storage) throw new Error("project_storage_changed");
  if (storage.storage_service_account) {
    assertStorageAccount(env, storage.storage_service_account);
    if (!storage.drive_folder_id) throw new Error("project_drive_folder_required");
    await withServiceAccount(env, token => verifyServiceAccountLocation(env, token, storage.drive_folder_id!));
    return storage;
  }
  const transition = randomId("switch");
  const started = Date.now();
  const owner = "EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = projects.id AND pm.user_id = ? AND pm.role = 'owner' AND u.disabled_at IS NULL)";
  const claim = await env.DB.prepare(`UPDATE projects SET storage_transition_id = ?, storage_transition_until = ?
    WHERE id = ? AND storage_service_account IS NULL AND (storage_transition_id IS NULL OR storage_transition_until < ?)
    AND NOT EXISTS (SELECT 1 FROM legacy_storage_operations l WHERE l.project_id = projects.id AND l.expires_at > ?) AND ${owner}`)
    .bind(transition, started + 10 * 60000, projectId, started, started, ownerId).run();
  if (!claim.meta.changes) throw new Error("project_storage_changed");
  let createdFolder: string | null = null;
  try {
    let folder = storage.drive_folder_id;
    if (!folder) {
      const root = env.GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID;
      if (!root) throw new Error("service_account_root_not_configured");
      const project = await env.DB.prepare("SELECT alias FROM projects WHERE id = ?").bind(projectId).first<{ alias: string }>();
      if (!project) throw new Error("project_storage_changed");
      const created = await withServiceAccount(env, async (token) => {
        const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/${encodeURIComponent(root)}`);
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("fields", "id,driveId,mimeType,trashed,capabilities(canAddChildren)");
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Drive root lookup failed with ${response.status}`);
        const target = await response.json<{ id: string; driveId?: string; mimeType: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean } }>();
        if (target.id !== root || target.driveId !== env.TEAM_DRIVE_ID || target.trashed || target.mimeType !== "application/vnd.google-apps.folder" || !target.capabilities?.canAddChildren) throw new Error("service_account_location_denied");
        return createDriveFolder(env, token, project.alias, root);
      });
      folder = createdFolder = created.id;
    }
    await withServiceAccount(env, async (token) => {
      await verifyServiceAccountLocation(env, token, folder!);
      const files = await env.DB.prepare("SELECT drive_file_id FROM project_files WHERE project_id = ?").bind(projectId).all<{ drive_file_id: string | null }>();
      for (const file of files.results) {
        if (Date.now() - started > 5 * 60000) throw new Error("project_storage_changed");
        if (file.drive_file_id) await verifyServiceAccountLocation(env, token, folder!, file.drive_file_id);
      }
    });
    const result = await env.DB.prepare(`UPDATE projects SET storage_service_account = ?, drive_folder_id = ?, storage_transition_id = NULL, storage_transition_until = NULL
      WHERE id = ? AND drive_folder_id IS ? AND storage_transition_id = ? AND storage_transition_until > ? AND ${owner}
      RETURNING drive_folder_id, storage_service_account, active_revision_id`)
      .bind(env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, folder, projectId, storage.drive_folder_id, transition, Date.now(), ownerId).first<ProjectStorage>();
    if (!result) throw new Error("project_storage_changed");
    createdFolder = null;
    return result;
  } finally {
    if (createdFolder) await env.DB.prepare("INSERT INTO drive_cleanup_folders (drive_folder_id, service_account, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(createdFolder, env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, Date.now()).run();
    await env.DB.prepare("UPDATE projects SET storage_transition_id = NULL, storage_transition_until = NULL WHERE id = ? AND storage_transition_id = ?")
      .bind(projectId, transition).run();
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
