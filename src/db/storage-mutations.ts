import type { Env } from "../env";
import { randomId } from "../lib/id";
import { getProjectStorage } from "../storage/service-account-drive";
import { getProjectFile } from "./project-files";

export async function removeServiceAccountFile(env: Env, projectId: string, path: string, userId: string): Promise<boolean> {
  const storage = await getProjectStorage(env, projectId);
  const file = await getProjectFile(env, projectId, path);
  if (!storage?.storage_service_account || !storage.drive_folder_id || !file) return false;
  const revision = randomId("rev");
  const active = "EXISTS (SELECT 1 FROM projects WHERE id = ? AND active_revision_id = ?)";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE projects SET active_revision_id = ?, updated_at = datetime('now') WHERE id = ? AND active_revision_id IS ?
      AND EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = projects.id AND pm.user_id = ? AND pm.role IN ('owner', 'editor') AND u.disabled_at IS NULL)`)
      .bind(revision, projectId, storage.active_revision_id, userId),
    env.DB.prepare(`INSERT INTO upload_objects (id, project_id, revision_id, drive_folder_id, drive_file_id, r2_key, service_account, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${active} ON CONFLICT(r2_key) DO NOTHING`)
      .bind(randomId("obj"), projectId, storage.active_revision_id ?? "legacy", storage.drive_folder_id, file.driveFileId, file.r2Key, storage.storage_service_account, Date.now(), projectId, revision),
    env.DB.prepare(`DELETE FROM project_files WHERE project_id = ? AND path = ? AND ${active}`).bind(projectId, path, projectId, revision)
  ]);
  if (!result[0].meta.changes) throw new Error("deployment_conflict");
  return true;
}

export async function removeServiceAccountProject(env: Env, projectId: string, userId: string): Promise<void> {
  const storage = await getProjectStorage(env, projectId);
  if (!storage?.storage_service_account || !storage.drive_folder_id) throw new Error("project_storage_changed");
  const authorized = "EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.user_id = ? AND pm.role = 'owner' AND u.disabled_at IS NULL)";
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO upload_objects (id, project_id, revision_id, drive_folder_id, drive_file_id, r2_key, service_account, created_at)
      SELECT 'cleanup_' || id, project_id, ?, ?, drive_file_id, r2_key, ?, ? FROM project_files WHERE project_id = ? AND ${authorized}
      ON CONFLICT(r2_key) DO NOTHING`)
      .bind(storage.active_revision_id ?? "legacy", storage.drive_folder_id, storage.storage_service_account, Date.now(), projectId, projectId, userId),
    env.DB.prepare(`INSERT INTO drive_cleanup_folders (drive_folder_id, service_account, created_at) SELECT ?, ?, ? WHERE ${authorized}
      ON CONFLICT(drive_folder_id) DO NOTHING`)
      .bind(storage.drive_folder_id, storage.storage_service_account, Date.now(), projectId, userId),
    env.DB.prepare(`DELETE FROM projects WHERE id = ? AND ${authorized}`).bind(projectId, projectId, userId)
  ]);
  if (!results[2].meta.changes) throw new Error("project_storage_changed");
}
